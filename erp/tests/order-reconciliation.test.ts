// erp/tests/order-reconciliation.test.ts
import { describe, expect, it } from "vitest";
import {
  STRIP_SEPARATOR, containerPieces, formatPieces, partsPieces, piecesOverOrUnder, reconcileOrder, rowsLeftOut,
  type ReconciliationOrder,
} from "@/lib/order-reconciliation";

// Hand-calculated orders, compared by value. Every sentence is the quantity corrections design's
// (§10.5, S1 to S9), except the container figure's, which are the weights design's (§9.5, S2 to
// S5). Each is compared whole, so a reworded figure, a figure held against the wrong total and a
// row counted that states nothing each turn a named case red. No server and no database are needed.

const line = (id: string, position: number, qty: number) => ({ id, position, qty });
const serialRows = (lineId: string, count: number) => Array.from({ length: count }, () => ({ lineId }));

/** One lead line of 250 pieces in one load of 250, no containers and no serials, unless told otherwise. */
function order(over: Partial<ReconciliationOrder> = {}): ReconciliationOrder {
  return { lines: [line("lead", 1, 250)], containers: [], loads: [{ qty: 250 }], serials: [], ...over };
}

/** The four figures by name, and the strip's whole line as the screen joins it. */
function strip(input: ReconciliationOrder) {
  const result = reconcileOrder(input);
  const [parts, containers, loads, serials] = result.figures;
  const joined = result.figures.map((figure) => figure.text).join(STRIP_SEPARATOR);
  return { parts, containers, loads, serials, agrees: result.agrees, joined };
}

// Container rows as the server sends them, with how many containers each holds. A row's Pieces is
// the total in all of its containers (the weights design, decision 5). `count` is carried here so
// that a sum which multiplies by it gives a different figure and turns a named case red.
/** Order 1004 of the demonstration dataset as the weights design's §9.1 restates it, which keeps
 *  the line's "2 over" under the row's new meaning: 3 baskets that hold 252 pieces between them. */
const BASKETS = { count: 3, pieces: 252 };
/** The owner's own example on a 30-piece order: 3 skids with 15 pieces, 1 wire basket with 15. */
const SKIDS = { count: 3, pieces: 15 };
const WIRE_BASKET = { count: 1, pieces: 15 };

describe("the pieces in the containers", () => {
  it("adds up the rows' Pieces and never multiplies by how many containers a row holds", () => {
    expect(containerPieces([BASKETS])).toEqual({ pieces: BigInt(252), stated: 1, skipped: 0 });
    expect(containerPieces([SKIDS, WIRE_BASKET])).toEqual({ pieces: BigInt(30), stated: 2, skipped: 0 });
  });

  it("leaves out a row with no Pieces, and counts it", () => {
    expect(containerPieces([{ pieces: 84 }, { pieces: null }]))
      .toEqual({ pieces: BigInt(84), stated: 1, skipped: 1 });
  });

  it("states nothing for no rows, and for rows that all lack Pieces", () => {
    expect(containerPieces([])).toEqual({ pieces: BigInt(0), stated: 0, skipped: 0 });
    expect(containerPieces([{ pieces: null }, { pieces: null }]))
      .toEqual({ pieces: BigInt(0), stated: 0, skipped: 2 });
  });

  it("keeps the sum exact past 2^53", () => {
    // 9,007,199,254,740,991 + 2 is ...993. A plain number holds ...992. No saved order comes near
    // it: Pieces is an INTEGER column, so it would take over four million rows. The leaf takes any
    // whole number, and the sum is held to BigInt with one figure larger than a column holds.
    expect(containerPieces([{ pieces: Number.MAX_SAFE_INTEGER }, { pieces: 2 }]).pieces)
      .toBe(BigInt("9007199254740993"));
  });

  it("separates with a middle dot (U+00B7) between two plain spaces", () => {
    expect(Array.from(STRIP_SEPARATOR, (character) => character.codePointAt(0))).toEqual([0x20, 0xb7, 0x20]);
  });
});

describe("the strip: Parts, Container pieces and Loads", () => {
  it("reads the approved line when every figure agrees (S1, S2, S3)", () => {
    const s = strip(order({ containers: [{ pieces: 250 }], loads: [{ qty: 120 }, { qty: 120 }, { qty: 10 }] }));
    expect(s.joined).toBe("Parts 250 pcs · Container pieces 250 · Loads 250 · Serials not entered");
    expect(s.agrees).toBe(true);
    for (const figure of [s.parts, s.containers, s.loads, s.serials]) {
      expect(figure.differs).toBe(false);
      expect(figure.section).toBeNull();
    }
  });

  it("always answers four figures, in the order Parts, Container pieces, Loads, Serials", () => {
    const keys = (input: ReconciliationOrder) => reconcileOrder(input).figures.map((figure) => figure.key);
    expect(keys(order())).toEqual(["parts", "containers", "loads", "serials"]);
    expect(keys(order({ containers: [BASKETS], loads: [{ qty: null }] })))
      .toEqual(["parts", "containers", "loads", "serials"]);
  });

  it("adds every line into Parts, the lead and the riders", () => {
    const s = strip(order({ lines: [line("lead", 1, 200), line("rider", 2, 50)], containers: [{ pieces: 250 }] }));
    expect(s.parts.text).toBe("Parts 250 pcs");
    expect(s.agrees).toBe(true);
  });

  it("groups thousands as the rest of the screen does", () => {
    const s = strip(order({ lines: [line("lead", 1, 1250)], containers: [{ pieces: 1250 }], loads: [{ qty: 1250 }] }));
    expect(s.joined).toBe("Parts 1,250 pcs · Container pieces 1,250 · Loads 1,250 · Serials not entered");
  });

  it("names containers that hold more than Parts, and links them and Parts (S4)", () => {
    // 3 baskets that hold 252 pieces between them, against 250 parts. The 3 does not enter.
    const s = strip(order({ containers: [BASKETS], loads: [{ qty: 120 }, { qty: 120 }, { qty: 10 }] }));
    expect(s.joined).toBe("Parts 250 pcs · Container pieces 252 · 2 over · Loads 250 · Serials not entered");
    expect(s.containers)
      .toEqual({ key: "containers", text: "Container pieces 252 · 2 over", differs: true, section: "containers" });
    expect(s.parts).toEqual({ key: "parts", text: "Parts 250 pcs", differs: false, section: "lines" });
    expect(s.loads).toEqual({ key: "loads", text: "Loads 250", differs: false, section: null });
    expect(s.agrees).toBe(false);
  });

  it("reads the plain figure when the rows' Pieces add up to Parts, however many containers hold them (S2)", () => {
    const s = strip(order({ lines: [line("lead", 1, 30)], containers: [SKIDS, WIRE_BASKET], loads: [{ qty: 30 }] }));
    expect(s.joined).toBe("Parts 30 pcs · Container pieces 30 · Loads 30 · Serials not entered");
    expect(s.containers).toEqual({ key: "containers", text: "Container pieces 30", differs: false, section: null });
    expect(s.agrees).toBe(true);
  });

  it("names containers that hold fewer than Parts", () => {
    expect(strip(order({ containers: [{ pieces: 200 }] })).containers.text).toBe("Container pieces 200 · 50 under");
  });

  it("names loads over and under Parts, and links them and Parts (S4)", () => {
    // A quantity corrected to 32 with the load left at 140.
    const over = strip(order({ lines: [line("lead", 1, 32)], loads: [{ qty: 140 }] }));
    expect(over.loads).toEqual({ key: "loads", text: "Loads 140 · 108 over", differs: true, section: "loads" });
    expect(over.parts.section).toBe("lines");
    expect(over.containers.section).toBeNull();
    expect(over.agrees).toBe(false);
    expect(strip(order({ loads: [{ qty: 120 }, { qty: 120 }] })).loads.text).toBe("Loads 240 · 10 under");
  });

  it("reads not entered, and no mismatch, with no containers and with rows that all lack Pieces (S3)", () => {
    for (const containers of [[], [{ pieces: null }, { pieces: null }]]) {
      const s = strip(order({ containers }));
      expect(s.containers)
        .toEqual({ key: "containers", text: "Container pieces not entered", differs: false, section: null });
      expect(s.parts.section).toBeNull();
      expect(s.agrees).toBe(true);
    }
  });

  it("says nothing of a row left out of a sum that agrees", () => {
    const s = strip(order({ containers: [{ pieces: 250 }, { pieces: null }] }));
    expect(s.containers).toEqual({ key: "containers", text: "Container pieces 250", differs: false, section: null });
    expect(s.agrees).toBe(true);
  });

  it("counts the rows left out of a sum that differs, one and several (S5)", () => {
    expect(strip(order({ containers: [{ pieces: 84 }, { pieces: null }] })).containers.text)
      .toBe("Container pieces 84 · 166 under · 1 row has no Pieces");
    const two = [{ pieces: 84 }, { pieces: null }, { pieces: null }];
    expect(strip(order({ containers: two })).containers.text)
      .toBe("Container pieces 84 · 166 under · 2 rows have no Pieces");
  });

  it("reads Loads not entered, and no mismatch, when every load is weight-only (S3)", () => {
    const s = strip(order({ loads: [{ qty: null }, { qty: null }] }));
    expect(s.loads).toEqual({ key: "loads", text: "Loads not entered", differs: false, section: null });
    expect(s.agrees).toBe(true);
  });

  it("reads Loads not entered, and no mismatch, on an order with no loads at all (S3)", () => {
    // No row states a quantity because there is no row. Parts is still 250, and nothing links.
    const s = strip(order({ loads: [] }));
    expect(s.joined).toBe("Parts 250 pcs · Container pieces not entered · Loads not entered · Serials not entered");
    expect(s.loads).toEqual({ key: "loads", text: "Loads not entered", differs: false, section: null });
    expect(s.parts.section).toBeNull();
    expect(s.agrees).toBe(true);
  });

  it("says nothing of a weight-only load left out of a sum that agrees", () => {
    expect(strip(order({ loads: [{ qty: 250 }, { qty: null }] })).loads)
      .toEqual({ key: "loads", text: "Loads 250", differs: false, section: null });
  });

  it("counts the loads left out of a sum that differs, one and several (S6)", () => {
    expect(strip(order({ loads: [{ qty: 120 }, { qty: null }] })).loads.text)
      .toBe("Loads 120 · 130 under · 1 load has no Qty");
    expect(strip(order({ loads: [{ qty: 120 }, { qty: null }, { qty: null }] })).loads.text)
      .toBe("Loads 120 · 130 under · 2 loads have no Qty");
  });

  it("groups thousands in the count of rows and of loads left out", () => {
    const containers = [{ pieces: 84 }, ...Array.from({ length: 1200 }, () => ({ pieces: null }))];
    expect(strip(order({ containers })).containers.text)
      .toBe("Container pieces 84 · 166 under · 1,200 rows have no Pieces");
    const loads = [{ qty: 120 }, ...Array.from({ length: 1200 }, () => ({ qty: null }))];
    expect(strip(order({ loads })).loads.text).toBe("Loads 120 · 130 under · 1,200 loads have no Qty");
  });

  it("groups thousands in a difference, over and under", () => {
    // One row of 1,250 pieces, and one load of 6,500, against 5,000 pieces.
    const s = strip(order({ lines: [line("lead", 1, 5000)], containers: [{ pieces: 1250 }], loads: [{ qty: 6500 }] }));
    expect(s.containers.text).toBe("Container pieces 1,250 · 3,750 under");
    expect(s.loads.text).toBe("Loads 6,500 · 1,500 over");
  });

  it("shows a sum past 2^53 exactly", () => {
    const rows = [{ pieces: Number.MAX_SAFE_INTEGER }, { pieces: 2 }];
    const s = strip(order({ lines: [line("lead", 1, 1)], containers: rows, loads: [{ qty: 1 }] }));
    expect(s.containers.text).toBe("Container pieces 9,007,199,254,740,993 · 9,007,199,254,740,992 over");
  });
});

describe("the strip: Serials", () => {
  it("reads not entered, and no mismatch, when no line has a serial (S3)", () => {
    const s = strip(order());
    expect(s.serials).toEqual({ key: "serials", text: "Serials not entered", differs: false, section: null });
    expect(s.agrees).toBe(true);
  });

  it("judges only a line that has serials, and gives the count over those lines (S9)", () => {
    // The rider has no serials and is not judged, whether or not its part requires them.
    const s = strip(order({
      lines: [line("lead", 1, 32), line("rider", 2, 50)],
      loads: [{ qty: 82 }],
      serials: serialRows("lead", 32),
    }));
    expect(s.serials).toEqual({ key: "serials", text: "Serials 32", differs: false, section: null });
    expect(s.parts.section).toBeNull();
    expect(s.agrees).toBe(true);
    const three = strip(order({
      lines: [line("lead", 1, 32), line("rider", 2, 50), line("third", 3, 10)],
      loads: [{ qty: 92 }],
      serials: [...serialRows("lead", 32), ...serialRows("third", 10)],
    }));
    expect(three.serials.text).toBe("Serials 42");
  });

  it("names a line with fewer serials than its quantity, and links Serials and Parts (S7)", () => {
    const s = strip(order({
      lines: [line("lead", 1, 10), line("rider", 2, 32)],
      loads: [{ qty: 42 }],
      serials: [...serialRows("lead", 10), ...serialRows("rider", 30)],
    }));
    expect(s.serials).toEqual({ key: "serials", text: "Serials Line 2: 30 of 32 · 2 under", differs: true, section: "serials" });
    expect(s.parts.section).toBe("lines");
    expect(s.loads.section).toBeNull();
    expect(s.agrees).toBe(false);
  });

  it("names a line with more serials than its quantity", () => {
    const s = strip(order({ lines: [line("lead", 1, 8)], loads: [{ qty: 8 }], serials: serialRows("lead", 10) }));
    expect(s.serials.text).toBe("Serials Lead: 10 of 8 · 2 over");
    expect(s.serials.differs).toBe(true);
  });

  it("judges line by line, never every serial against every part (S8)", () => {
    // 10 + 30 serials is 40, and Parts is 8 + 32 = 40. Each line is still wrong.
    const s = strip(order({
      lines: [line("lead", 1, 8), line("rider", 2, 32)],
      loads: [{ qty: 40 }],
      serials: [...serialRows("lead", 10), ...serialRows("rider", 30)],
    }));
    expect(s.serials.text).toBe("Serials Lead: 10 of 8 · 2 over · Line 2: 30 of 32 · 2 under");
    expect(s.serials.section).toBe("serials");
    expect(s.agrees).toBe(false);
  });

  it("lists the lines in position order, whatever order the payload has them in", () => {
    const s = strip(order({
      lines: [line("rider", 2, 32), line("lead", 1, 8)],
      loads: [{ qty: 40 }],
      serials: [...serialRows("rider", 30), ...serialRows("lead", 10)],
    }));
    expect(s.serials.text).toBe("Serials Lead: 10 of 8 · 2 over · Line 2: 30 of 32 · 2 under");
  });

  it("does not count a serial row whose line is not on the order", () => {
    expect(strip(order({ serials: serialRows("gone", 3) })).serials)
      .toEqual({ key: "serials", text: "Serials not entered", differs: false, section: null });
    expect(strip(order({ serials: [...serialRows("lead", 250), ...serialRows("gone", 3)] })).serials.text)
      .toBe("Serials 250");
  });

  it("groups thousands in a line's count and quantity", () => {
    const under = strip(order({ lines: [line("lead", 1, 1500)], loads: [{ qty: 1500 }], serials: serialRows("lead", 1200) }));
    expect(under.serials.text).toBe("Serials Lead: 1,200 of 1,500 · 300 under");
    const exact = strip(order({ lines: [line("lead", 1, 1500)], loads: [{ qty: 1500 }], serials: serialRows("lead", 1500) }));
    expect(exact.serials.text).toBe("Serials 1,500");
  });
});

// The order totals table (`src/lib/order-totals.ts`) adds up and words pieces through these four,
// so the table and the strip cannot do either two ways (the weights design §10.2, owner ruling W8).
describe("what the order totals table shares with the strip", () => {
  it("adds every line's quantity into the parts' pieces, and gives 0 for no lines", () => {
    expect(partsPieces([{ qty: 200 }, { qty: 50 }])).toBe(BigInt(250));
    expect(partsPieces([])).toBe(BigInt(0));
  });

  it("groups a count of pieces, and keeps one past 2^53 exact", () => {
    expect(formatPieces(BigInt(0))).toBe("0");
    expect(formatPieces(BigInt(1075))).toBe("1,075");
    expect(formatPieces(BigInt("9007199254740993"))).toBe("9,007,199,254,740,993");
  });

  it("words a difference in pieces as over or under, grouped", () => {
    expect(piecesOverOrUnder(BigInt(2))).toBe("2 over");
    expect(piecesOverOrUnder(BigInt(-108))).toBe("108 under");
    expect(piecesOverOrUnder(BigInt(-3750))).toBe("3,750 under");
  });

  it("words the rows left out of the pieces, one and several, grouped", () => {
    expect(rowsLeftOut(1)).toBe("1 row has no Pieces");
    expect(rowsLeftOut(2)).toBe("2 rows have no Pieces");
    expect(rowsLeftOut(1200)).toBe("1,200 rows have no Pieces");
  });
});
