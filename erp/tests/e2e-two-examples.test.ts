// The table the weights-two-examples flow reads, held to the program (the weights design §14.2,
// §14.3 and §14.5, "The table"). The flow waits for each screen and each stored page to read what
// `expectedReadings` holds, so in a browser a wrong figure there is a red flow and nothing more.
// Here each reading of both sides is worked out again from `EXAMPLES`: the two order screens' and
// the two shipment screens' through the leaves those screens call, and the traveler's, the
// shipping ticket's and the bill of lading's from pages the real builders print, read by the
// reader the flow reads with. `EXAMPLES` itself is held to the fixture script's source.
//
// What no case here can hold: that a screen shows a leaf's answer in the place the flow looks.
// Only a browser run holds that.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { formatNumber } from "@/lib/format";
import { calculatedNetWeight, tareTotal } from "@/lib/net-weight";
import { entryTareEach, tareEachText, typeDefaultTare } from "@/lib/container-tare-prefill";
import { UNSAVED_TOTALS, orderTotals, savedOrderTotalsInput, weighedFigure, type OrderTotalsView } from "@/lib/order-totals";
import { STRIP_SEPARATOR, reconcileOrder } from "@/lib/order-reconciliation";
import { shipRemainder } from "@/lib/ship-remainder";
import { prefillContainerRow, shipmentContainerFields, tareEachForSave } from "@/lib/shipment-container-rows";
import { NO_REPORTS, newShipmentTotalsInput, savedShipmentTotalsInput, shipmentTotals, totalsForCaption, type TotalsTableView } from "@/lib/shipment-totals";
import { normalizeStoredConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { NET_WEIGHT } from "@/lib/weight-terms";
import { entryContainerBody, entryTotalsInput } from "@/app/orders/new/entry-state";
import type { ContainerDraft, ContainerTypeOption } from "@/app/orders/new/order-draft";
import { EXAMPLES, expectedReadings } from "../e2e/flows/weights-two-examples.mjs";
import { assertRun, piecesLines, poundsCents, printedPages, weightLines } from "../e2e/lib/printed-page.mjs";
import { bolPdf, ticketPdf, travelerPdf, type PageOrder } from "./helpers/example-pages";
import { all, run } from "./helpers/source-lift";
import { seedLiteral } from "./helpers/stored-configs";

type Example = "bins" | "skids";
const NAMES: Example[] = ["bins", "skids"];
/** An order number of this file's own. No reading of the order side holds it. */
const ORDER_NUMBER = 2001;
/** How a failure of the reader, or of `expectedReadings`, is told from any other error. */
const BY_ASSERT = expect.objectContaining({ code: "ERR_ASSERTION" });

/** The example as the three pages print it: its line and its container rows from EXAMPLES, the line's weight from `calculatedNetWeight`. */
function pageOrder(example: Example, orderNumber: number): PageOrder {
  const keyed = EXAMPLES[example];
  const weight = calculatedNetWeight(keyed.qty, keyed.eachLb);
  if (weight === null) throw new Error(`the ${example} example's net weight cannot be worked out`);
  return {
    number: orderNumber,
    lines: [{ qty: keyed.qty, eachWeight: keyed.eachLb, weight, partNumber: keyed.partNumber, partName: keyed.partName }],
    containers: keyed.containers.map((row) => ({ typeName: row.typeName, count: row.count, pieces: row.pieces, tareEach: row.typeTareEach })),
  };
}

/** The two templates each page is printed under: ["built-in", undefined] and ["seed-stored", normalizeStoredConfig(docType, seedLiteral(docType))]. */
function templates(docType: "TRAVELER" | "SHIPPER" | "BOL"): [name: string, config: TemplateConfig | undefined][] {
  return [["built-in", undefined], ["seed-stored", normalizeStoredConfig(docType, seedLiteral(docType))]];
}

/** The example's container types as an order screen's pick list holds them. A type's id here is
 *  the fixture key the flow picks it by, and its default is the figure the type remembers. */
function pickList(example: Example): ContainerTypeOption[] {
  return EXAMPLES[example].containers.map((row) => ({ id: row.typeIdKey, name: row.typeName, tareEach: row.typeTareEach }));
}

/** The container rows as the shared helper keys them into order entry: a type, Containers, and
 *  Pieces only where the example states one. Nothing is typed in Tare each. */
function keyedRows(example: Example): ContainerDraft[] {
  return EXAMPLES[example].containers.map((row, index) => ({
    id: `row-${index + 1}`, typeId: row.typeIdKey, count: String(row.count), pieces: row.pieces === null ? "" : String(row.pieces),
    tareEachOverride: null, scaleGross: "", customerContainerId: "",
  }));
}

/** Those rows as order entry sends them and the order then holds them: `entryContainerBody`, with
 *  the tare each as the number the server answers. */
function storedRows(example: Example) {
  return keyedRows(example).map((row) => {
    const sent = entryContainerBody(row, pickList(example));
    return { count: sent.count, pieces: sent.pieces, tareEach: sent.tareEach === null ? null : Number(sent.tareEach), scaleGross: null };
  });
}

/** A view of the Order totals table as `waitForTotals` reads the table drawn from it. Neither
 *  screen draws the tag here: order entry never does, and the saved order's grid is not unsaved. */
function asRead(view: OrderTotalsView) {
  return {
    tag: null,
    rows: Object.fromEntries(view.rows.map((row) => [row.heading, [row.pieces, row.net, row.tare, row.gross]])),
    note: view.note,
    weighed: [...view.weighed],
  };
}

// ---- The fixture script's source, read and never run --------------------------------------------

const script = ts.createSourceFile("db-fixtures.ts",
  readFileSync(new URL("../e2e/lib/db-fixtures.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const text = (node: ts.Node) => node.getText(script);

/** The script's own FIXTURE literal, evaluated with nothing else of the script in reach, as
 *  tests/e2e-fixture-lists.test.ts evaluates it. */
const FIXTURE = (() => {
  const declaration = all(script, ts.isVariableDeclaration).find((one) => text(one.name) === "FIXTURE");
  if (declaration?.initializer === undefined) throw new Error("db-fixtures.ts has no FIXTURE literal");
  return run<Record<string, string>>(text(declaration.initializer), {});
})();

/** An object literal's properties, by name. Empty for anything else. */
function properties(node: ts.Node | undefined): Map<string, ts.Expression> {
  const found = new Map<string, ts.Expression>();
  if (node !== undefined && ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) found.set(text(property.name), property.initializer);
    }
  }
  return found;
}

/** A string the script writes as a literal or as `FIXTURE.<key>`. Undefined for anything else. */
function written(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && text(node.expression) === "FIXTURE") return FIXTURE[node.name.text];
  return undefined;
}

/** The first argument of each call of `orderablePart`, in source order. */
const partsMade = all(script, ts.isCallExpression).filter((call) => text(call.expression) === "orderablePart")
  .map((call) => properties(call.arguments[0]));
const assigned = all(script, ts.isPropertyAssignment);
const declared = all(script, ts.isVariableDeclaration);

/** The `data` of the `tx.containerType.create` that made the row a flow is handed as
 *  `ctx.fixtures[idKey]`: the script hands it on as `idKey: <name>.id`, and declares `<name>` as
 *  that call's answer. Undefined when the script holds no such pair. */
function typeMade(idKey: string): Map<string, ts.Expression> | undefined {
  for (const handed of assigned) {
    if (text(handed.name) !== idKey || !ts.isPropertyAccessExpression(handed.initializer) || handed.initializer.name.text !== "id") continue;
    const name = text(handed.initializer.expression);
    for (const one of declared) {
      const made = one.initializer !== undefined && ts.isAwaitExpression(one.initializer) ? one.initializer.expression : one.initializer;
      if (text(one.name) === name && made !== undefined && ts.isCallExpression(made) && text(made.expression) === "tx.containerType.create") {
        return properties(properties(made.arguments[0]).get("data"));
      }
    }
  }
  return undefined;
}

// ---- The table ----------------------------------------------------------------------------------

describe("EXAMPLES is what the fixture script creates (e2e/lib/db-fixtures.ts)", () => {
  it("is frozen at every level", () => {
    const loose: string[] = [];
    const walk = (value: unknown, where: string): void => {
      if (typeof value !== "object" || value === null) return;
      if (!Object.isFrozen(value)) loose.push(where);
      for (const [key, held] of Object.entries(value)) walk(held, `${where}.${key}`);
    };
    walk(EXAMPLES, "EXAMPLES");
    expect(loose).toEqual([]);
  });

  it.each(NAMES)("the %s example's part: its number, its name and its each weight", (example) => {
    const keyed = EXAMPLES[example];
    expect(FIXTURE[keyed.partNumberKey]).toBe(keyed.partNumber);
    // One call makes a part of that number, with that name and that each weight.
    expect(partsMade.filter((part) => written(part.get("partNumber")) === keyed.partNumber)
      .map((part) => [written(part.get("name")), Number(written(part.get("eachWeight")))])).toEqual([[keyed.partName, keyed.eachLb]]);
  });

  it.each(NAMES)("the %s example's container types: each one's name and the tare each it remembers", (example) => {
    for (const row of EXAMPLES[example].containers) {
      const data = typeMade(row.typeIdKey);
      expect(data === undefined ? undefined : [written(data.get("name")), data.has("tareEach") ? Number(written(data.get("tareEach"))) : null],
        row.typeIdKey).toEqual([row.typeName, row.typeTareEach]);
    }
  });
});

describe("expectedReadings", () => {
  it("refuses an example it does not know and an order number that is not a whole number above 0, by node:assert", () => {
    expect(() => expectedReadings("totes", ORDER_NUMBER)).toThrow(BY_ASSERT);
    for (const number of [0, 1.5]) expect(() => expectedReadings("bins", number), String(number)).toThrow(BY_ASSERT);
  });

  it("hands back a fresh object each call, and the saved order's rows and table are not order entry's", () => {
    const first = expectedReadings("bins", ORDER_NUMBER);
    const asFirstRead = structuredClone(first);
    first.entry.rows[0].tareEach = "written by this case";
    first.entry.totals.rows.Order[3] = "written by this case";
    expect(first.saved).toEqual(asFirstRead.saved);
    // The shipment side too: the saved shipment's rows are not the new shipment's.
    first.newShipment.rows[0].tareEach = "written by this case";
    expect(first.savedShipment).toEqual(asFirstRead.savedShipment);
    // A page's list of each side.
    first.traveler.weights.push("written by this case");
    first.ticket.weights.push("written by this case");
    expect(expectedReadings("bins", ORDER_NUMBER)).toEqual(asFirstRead);
  });
});

describe.each(NAMES)("the %s example's order side, as expectedReadings holds it", (example) => {
  const keyed = EXAMPLES[example];
  const weight = pageOrder(example, ORDER_NUMBER).lines[0].weight;
  const { entry, saved, traveler } = expectedReadings(example, ORDER_NUMBER);

  it("order entry: the quantity box, each container row and the Order totals table", () => {
    const types = pickList(example);
    expect(entry.quantity).toBe(String(keyed.qty));
    expect(entry.rows).toEqual(keyedRows(example).map((row, index) => {
      const tareEach = entryTareEach(row.tareEachOverride, typeDefaultTare(types, row.typeId));
      return { type: keyed.containers[index].typeName, count: row.count, pieces: row.pieces, tareEach,
        tareTotal: formatNumber(tareTotal({ count: row.count, tareEach }), 2) };
    }));
    expect(entry.totals).toEqual(asRead(orderTotals(entryTotalsInput({
      draftLines: [{ partId: "part" }], lines: [{ partId: "part", qty: keyed.qty, weight }],
      parts: [{ id: "part", eachWeight: keyed.eachLb }], containers: keyedRows(example), containerTypes: types,
    }))));
  });

  it("the saved order: each container row as stored, the Order totals table and the top line", () => {
    const stored = storedRows(example);
    expect(saved.rows).toEqual(stored.map((row, index) => {
      const tareEach = tareEachText(row.tareEach);
      return { type: keyed.containers[index].typeName, count: String(row.count), pieces: row.pieces === null ? "" : String(row.pieces),
        tareEach, tareTotal: formatNumber(tareTotal({ count: String(row.count), tareEach }), 2) };
    }));
    const lines = [{ id: "line", position: 1, partId: "part", qty: keyed.qty, weight, part: { eachWeight: keyed.eachLb } }];
    expect(saved.totals).toEqual(asRead(orderTotals(savedOrderTotalsInput(lines, stored))));
    // One load of every piece: the parts have no load limit. The figure is the loads' pieces added up.
    const strip = reconcileOrder({ lines, containers: stored, loads: [{ qty: keyed.qty }], serials: [] });
    expect(saved.strip).toBe(strip.figures.map((figure) => figure.text).join(STRIP_SEPARATOR));
  });

  it("the saved order's top line ends at its four piece figures: the weighed figure answers none for the order as stored", () => {
    // The screen draws a fifth figure after the four when `weighedFigure` answers one (ReconciliationStrip.tsx).
    expect(weighedFigure({ lines: [{ weight }], containers: storedRows(example) })).toBeNull();
  });

  it.each(templates("TRAVELER"))("the traveler under the %s template: its page count, its runs, its weight lines and its piece lines", async (_name, config) => {
    const what = `the ${example} traveler`;
    const [lines] = printedPages(await travelerPdf(pageOrder(example, ORDER_NUMBER), config), { pages: traveler.pages, what });
    // Three runs, as §14.2's table gives a traveler. A loop over fewer would hold less and pass.
    expect(traveler.runs).toHaveLength(3);
    for (const wanted of traveler.runs) assertRun(lines, wanted, what);
    expect(weightLines(lines)).toEqual(traveler.weights);
    expect(piecesLines(lines)).toEqual(traveler.pieces);
  });

  it("the traveler's three totals are the lines its Order totals run holds", () => {
    const worded = (word: string, figure: string | null) => (figure === null ? word : `${word} ${figure}`);
    const block: string[] = traveler.runs.find((held: string[]) => held[0] === "Order totals") ?? [];
    assertRun(block, [worded("Net", traveler.totals.net), worded("Tare", traveler.totals.tare), worded("Gross", traveler.totals.gross)],
      `the ${example} traveler's Order totals run`);
  });

  it("by amount, each total the traveler prints is the saved order's Order row cell, and a total it leaves bare is a cell that holds a word", () => {
    const [, net, tare, gross] = saved.totals.rows.Order;
    for (const [name, printed, cell] of [["Net", traveler.totals.net, net], ["Tare", traveler.totals.tare, tare], ["Gross", traveler.totals.gross, gross]]) {
      if (printed === null) expect(() => poundsCents(cell, name), name).toThrow(BY_ASSERT);
      else expect(poundsCents(printed, name), name).toBe(poundsCents(cell, name));
    }
  });
});

it("plain node imports the flow's file, as the harness does and vitest does not", () => {
  const flow = new URL("../e2e/flows/weights-two-examples.mjs", import.meta.url).href;
  // The test runner's own node options are not passed on.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const printed = execFileSync(process.execPath, ["--input-type=module", "--eval",
    `const flow = await import(${JSON.stringify(flow)}); console.log(JSON.stringify([typeof flow.run, typeof flow.expectedReadings, Object.keys(flow.EXAMPLES)]));`],
  { encoding: "utf8", env, timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  expect(JSON.parse(printed)).toEqual(["function", "function", ["bins", "skids"]]);
  // The case starts a second node, so it has a limit of its own: 30 seconds.
}, 30_000);

// The shipment side of the same table (rows A3 to A5 and B3 to B5 of §14.3). The two shipment
// screens are worked out through the leaves those screens call, and the ticket and the bill of
// lading from pages the real builders print, read by the same reader.
describe.each(["bins", "skids"] as const)("the shipment side of the %s example (e2e/flows/weights-two-examples.mjs)", (example) => {
  /** A shipment screen's reading and a printed page's, as far as these cases read them. */
  type Screen = {
    panel: string; quantity: string; orderTable: string;
    rows: { type: string; count: string; tareEach: string; tareTotal: string }[];
    totals: { tag: string | null; cells: string[]; note: string | null };
  };
  type Paper = { pages: number; runs: string[][]; weights: string[]; pieces: string[] };

  const order = pageOrder(example, ORDER_NUMBER);
  /** The form's container rows as Add order fills them from the order's. */
  const formRows = () => order.containers.map((row, index) => prefillContainerRow({ id: `c${index}`, count: row.count, tareEach: row.tareEach }));
  /** A table's view as a flow reads the table drawn from it, as tests/e2e-shipment-totals.test.ts has it. */
  const read = (view: TotalsTableView | null) =>
    view && { tag: view.unsaved ? UNSAVED_TOTALS : null, cells: [view.net, view.tare, view.gross], note: view.note };
  /** Whether a screen's cell holds a figure. `poundsCents` reads a figure and refuses a word by node:assert. */
  const figure = (cell: string): boolean => {
    try {
      poundsCents(cell, "a screen's cell");
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ERR_ASSERTION") throw error;
      return false;
    }
  };
  /** Every place where two readings differ: the path to it, and the two values. */
  function differences(one: unknown, other: unknown, at = ""): [string, unknown, unknown][] {
    if (typeof one === "object" && one !== null && typeof other === "object" && other !== null) {
      const keys = new Set([...Object.keys(one), ...Object.keys(other)]);
      return [...keys].flatMap((key) => differences(
        (one as Record<string, unknown>)[key], (other as Record<string, unknown>)[key], at === "" ? key : `${at}.${key}`));
    }
    return Object.is(one, other) ? [] : [[at, one, other]];
  }

  it("the new shipment reads what Add order fills, and the three cells the totals leaf gives for it", () => {
    const reading = expectedReadings(example, ORDER_NUMBER).newShipment as Screen;
    const rows = formRows();
    const weight = String(shipRemainder(order.lines[0].weight, 0));
    const view = shipmentTotals(newShipmentTotalsInput([{ orderNumber: ORDER_NUMBER, lines: [{ weight }], containers: rows }]));
    expect(reading.quantity).toBe(String(shipRemainder(order.lines[0].qty, 0)));
    expect(reading.rows).toEqual(rows.map((row, index) => ({
      type: order.containers[index].typeName, count: row.count, tareEach: row.tareEach, tareTotal: formatNumber(tareTotal(row), 2),
    })));
    expect(totalsForCaption(reading.panel)).toBe(view.orders[0].caption);
    expect(reading.orderTable).toBe(view.orders[0].caption);
    expect([reading.totals, reading.totals]).toEqual([view.orders[0], view.shipment].map(read));
  });

  it("the saved shipment reads what the form sent, as the saved page spells and adds it up", () => {
    const reading = expectedReadings(example, ORDER_NUMBER).savedShipment as Screen;
    // What Save shipment sends for each row, and the figure the shipment then holds.
    const stored = formRows().map((row) => {
      const sent = tareEachForSave(row.tareEach);
      return { orderContainerId: row.orderContainerId, count: Number(row.count), tareEach: sent === null ? null : Number(sent) };
    });
    const boxes = stored.map(shipmentContainerFields);
    const view = shipmentTotals(savedShipmentTotalsInput(
      [{ id: "so1", label: `${ORDER_NUMBER}-1`, lines: [{ weight: order.lines[0].weight }], containers: stored }], NO_REPORTS));
    expect(reading.quantity).toBe(String(order.lines[0].qty));
    expect(reading.rows).toEqual(boxes.map((row, index) => ({
      type: order.containers[index].typeName, count: row.count, tareEach: row.tareEach, tareTotal: formatNumber(tareTotal(row), 2),
    })));
    expect(totalsForCaption(reading.panel)).toBe(view.orders[0].caption);
    expect(reading.orderTable).toBe(view.orders[0].caption);
    expect([reading.totals, reading.totals]).toEqual([view.orders[0], view.shipment].map(read));
  });

  it.each(templates("SHIPPER"))("the shipping ticket printed under the %s template draws the table's runs and lists", async (_name, config) => {
    const reading = expectedReadings(example, ORDER_NUMBER).ticket as Paper;
    const what = `the ${example} shipping ticket`;
    const [lines] = printedPages(await ticketPdf(order, config), { pages: reading.pages, what });
    // Five runs, as §14.2's table gives a shipping ticket. A loop over fewer would hold less and pass.
    expect(reading.runs).toHaveLength(5);
    for (const wanted of reading.runs) assertRun(lines, wanted, what);
    expect(weightLines(lines)).toEqual(reading.weights);
    expect(piecesLines(lines)).toEqual(reading.pieces);
  });

  it.each(templates("BOL"))("the bill of lading printed under the %s template draws the table's run and lists", async (_name, config) => {
    const { bol } = expectedReadings(example, ORDER_NUMBER);
    const reading = bol as Paper;
    const what = `the ${example} bill of lading`;
    const [lines] = printedPages(await bolPdf(order, config), { pages: reading.pages, what });
    // One run, and it is the reading's own package count, weight and word after the heading it starts at.
    expect(reading.runs).toEqual([["Check Column", bol.packages, bol.weight, bol.word]]);
    for (const wanted of reading.runs) assertRun(lines, wanted, what);
    expect(weightLines(lines)).toEqual(reading.weights);
    expect(piecesLines(lines)).toEqual(reading.pieces);
  });

  it("the ticket's totals are the saved shipment's cells with lb added, and a row prints only where its cell is a figure", () => {
    const { ticket, savedShipment } = expectedReadings(example, ORDER_NUMBER);
    expect([ticket.totals.net, ticket.totals.tare, ticket.totals.gross])
      .toEqual((savedShipment as Screen).totals.cells.map((cell) => (figure(cell) ? `${cell} lb` : null)));
  });

  it("the bill of lading's weight is, by amount, the saved shipment's Gross cell, or its Net cell where Gross is a word, and the line under it says which", () => {
    const { bol, savedShipment } = expectedReadings(example, ORDER_NUMBER);
    const [net, , gross] = (savedShipment as Screen).totals.cells;
    expect(poundsCents(bol.weight, "the bill of lading's weight")).toBe(poundsCents(figure(gross) ? gross : net, "the screen's cell"));
    expect(bol.word).toBe(figure(gross) ? "Gross weight" : NET_WEIGHT);
  });

  it("two order numbers change the five strings built from the number, and nothing else the flow reads", () => {
    const found = differences(expectedReadings(example, 2001), expectedReadings(example, 2002));
    expect(found.map(([path, one, other]) => [path.replace(/(\.\d+)+$/, ""), one, other]).sort()).toEqual([
      ["newShipment.orderTable", "Totals for #2001", "Totals for #2002"],
      ["newShipment.panel", "#2001", "#2002"],
      ["savedShipment.orderTable", "Totals for 2001-1", "Totals for 2002-1"],
      ["savedShipment.panel", "2001-1", "2002-1"],
      ["ticket.runs", "Order No.: 2001", "Order No.: 2002"],
    ]);
  });
});
