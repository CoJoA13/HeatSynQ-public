import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { Prisma } from "../prisma/generated/prisma/client";
import { readableMessage } from "@/server/error-message";
import { HttpError } from "@/server/errors";
import { createOrder, defaultRequestDate } from "@/server/order-create";
import {
  LINE, SERIAL_ITEM, createSerials, parseDate, resolveLineParts, resolveQuoteLinks,
  type Db, type LineInput, type ResolvedPart,
} from "@/server/order-internals";
import { lockCurrentRevision } from "@/server/part-process-steps";
import { LINE_KEY_BOXES, SERIAL_KEY_BOXES, lineRefusalField, type RefusalLine } from "@/lib/line-refusal-field";

// Where New order takes the operator when the SERVER refuses a part line's or a serial's value
// (#546): the refused line's own box, read from the path the server names or from the `Line N`
// label it writes, the box chosen from the words after the label only.
//
// One case reads the test database (`defaultRequestDate`, below), so this file needs it, as #494's
// container test does; every other case runs on the schemas or on a fake transaction.
//
// Produced by the server's own code:
// - every path refusal: `createOrder` refuses its body before it reads anything, and
//   `readableMessage` is what `handle()` answers for that refusal;
// - the `Line N` sentences: `resolveLineParts` (that part does not exist, belongs to another
//   customer, is inactive), `resolveQuoteLinks` through `judgeQuoteLine` (all eight quote reasons)
//   and `createSerials` through `duplicateSerialError` (a serial entered twice, and `That serial is
//   already on this line`), each run on a fake transaction object that answers the one read or
//   write the function makes, so the part numbers, customer codes and serials are the test's to
//   choose. `handle()` answers an `HttpError` with its message, which `readableMessage` returns.
//   Three cases hand `createSerials` or `resolveQuoteLinks` no part for line 2, so its label is
//   the bare `Line 2`. No caller does that: order-create.ts and order-edit.ts pass the parts
//   `resolveLineParts` resolved, and it refuses a line whose part it does not find. So the server
//   never writes a bare label before a serial entered twice or a quote reason; each case says so;
// - `This part has no process steps` (`lockCurrentRevision`, on a fake transaction that finds no
//   revision), `That customer does not exist` (`defaultRequestDate`, reading the test database
//   for a customer id no row has) and a date's refusal (`parseDate`).
//
// Typed, each said so at its case: `Line 0` (the server counts lines from 1), a duplicate of a
// blank serial (the server refuses a blank serial in the parse, before any repeat is looked for),
// a label with no `): ` after it, a path naming a prototype key (the server refuses an unknown key
// one level up), a lower-case `line 2:` (the server writes `Line`), and the saved order's sentences used to reach each word of the word scan and an
// invoice's `Line N · …` refusal, neither of which New order receives.

/** Three part lines, as the page holds them. Line 2's serials repeat `A`, once with a space. */
const PAGE: RefusalLine[] = [
  { id: "l1", serials: [{ id: "a1", serial: "LEAD-1" }] },
  { id: "l2", serials: [{ id: "s1", serial: "B" }, { id: "s2", serial: "A " }, { id: "s3", serial: "A" }] },
  { id: "l3", serials: [] },
];

/** Every box is in the document; and none is. Only the quote box is ever asked about. */
const ALL = () => true;
const NONE = () => false;

/** A `shown` that answers `answer` and records every id it is asked about. */
function recorder(answer: boolean) {
  const asked: string[] = [];
  return { asked, shown: (fieldId: string) => { asked.push(fieldId); return answer; } };
}

/** A part line the create schema takes. */
const GOOD = { partId: "part-1", qty: 30, weight: "75" };

/** What the server answers to a create of `body`, over one good part line, in `handle()`'s words. */
async function bodyRefusal(body: Record<string, unknown>): Promise<string> {
  const err = await createOrder({ customerId: "cust-1", lines: [GOOD], ...body }).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ZodError);
  return readableMessage(err);
}

/** What the server answers to a create whose part lines are `lines`. */
const linesRefusal = (lines: unknown) => bodyRefusal({ lines });

/** What a server function that throws an `HttpError` answers, in `handle()`'s words. */
async function httpRefusal(run: () => Promise<unknown>): Promise<string> {
  const err = await run().then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  return readableMessage(err);
}

/** A part as `resolveLineParts` reads it: only what it and `lineLabel` look at. */
type FakePart = { id: string; partNumber: string; customerId: string; active: boolean; customer: { code: string } };
const fakePart = (id: string, partNumber: string, over: Partial<FakePart> = {}): FakePart =>
  ({ id, partNumber, customerId: "cust-1", active: true, customer: { code: "ACME" }, ...over });
const resolved = (parts: FakePart[]) => parts as unknown as ResolvedPart[];

/** `count` parsed part lines with parts p1, p2, …, no quote link, and the serials given per line. */
function lineInputs(count: number, serials: string[][] = []): LineInput[] {
  return Array.from({ length: count }, (_, i) => LINE.parse({
    partId: `p${i + 1}`, qty: 30, weight: "75", quoteLineId: null,
    serials: (serials[i] ?? []).map((serial) => ({ serial })),
  }));
}

/** `resolveLineParts`' refusal of `lines` when the database holds `found`. */
function partsRefusal(found: FakePart[], lines = lineInputs(3)): Promise<string> {
  const tx = { part: { findMany: async () => found } } as unknown as Db;
  return httpRefusal(() => resolveLineParts(tx, "cust-1", lines));
}

/** Line 2's part, inactive and numbered `partNumber`, between two good lines. */
const inactiveSecond = (partNumber: string, code = "ACME") => partsRefusal([
  fakePart("p1", "P-1"), fakePart("p2", partNumber, { active: false, customer: { code } }), fakePart("p3", "P-3"),
]);

/** `duplicateSerialError`'s sentence, reached the way a create reaches it: `createSerials` writes
 *  the serials and the database refuses a repeat (P2002). */
function serialsRefusal(serials: string[][], parts = [fakePart("p1", "P-1"), fakePart("p2", "P-2"), fakePart("p3", "P-3")]) {
  const tx = {
    orderSerial: {
      createMany: async () => {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      },
    },
  } as unknown as Db;
  return httpRefusal(() => createSerials(tx, "order-1", ["l1", "l2", "l3"], lineInputs(3, serials), resolved(parts)));
}

describe("lineRefusalField: the server's keys", () => {
  it("has a box for every key of the server's part line and serial", () => {
    // A key the server adds or renames without a box here would go to the line's Part box, or
    // the serial's value box.
    expect(Object.keys(LINE_KEY_BOXES).sort()).toEqual(Object.keys(LINE.shape).sort());
    expect(Object.keys(SERIAL_KEY_BOXES).sort()).toEqual(Object.keys(SERIAL_ITEM.shape).sort());
  });
});

describe("lineRefusalField: the refused line's box, from the server's path", () => {
  // One refused value per key of the server's line, each with its own box.
  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["partId", { partId: "" }, "part"],
    ["qty", { qty: 0 }, "qty"],
    ["weight", { weight: "-1" }, "weight"],
    ["serials", { serials: "A" }, "serials"],
    ["quoteLineId", { quoteLineId: "" }, "quote"],
  ];

  it.each(REFUSED)("sends a refused %s on the second line to that line's box", async (key, refused, box) => {
    const message = await linesRefusal([GOOD, { ...GOOD, ...refused }, GOOD]);
    expect(message.startsWith(`lines.1.${key}: `), message).toBe(true);
    expect(lineRefusalField(message, PAGE, ALL)).toBe(`entry-line-l2-${box}`);
  });

  it.each(REFUSED.filter(([key]) => key !== "quoteLineId"))(
    "sends a refused %s on the second line to that line's box when no box is shown", async (key, refused, box) => {
      // Only a quote box is asked about; every other box is the answer whatever the page shows.
      const message = await linesRefusal([GOOD, { ...GOOD, ...refused }, GOOD]);
      expect(lineRefusalField(message, PAGE, NONE)).toBe(`entry-line-l2-${box}`);
    });

  it("sends a refused quote link to the line's Part box when the line's quote picker shows no list", async () => {
    const message = await linesRefusal([GOOD, { ...GOOD, quoteLineId: "" }, GOOD]);
    const hidden = recorder(false);
    expect(lineRefusalField(message, PAGE, hidden.shown)).toBe("entry-line-l2-part");
    expect(hidden.asked).toEqual(["entry-line-l2-quote"]);
    const shown = recorder(true);
    expect(lineRefusalField(message, PAGE, shown.shown)).toBe("entry-line-l2-quote");
    expect(shown.asked).toEqual(["entry-line-l2-quote"]);
  });

  it.each([
    ["serial", { serial: "  " }, "entry-line-l2-serial-s2"],
    ["description", { description: "x".repeat(501) }, "entry-line-l2-serial-s2-description"],
  ])("sends a refused %s on the second line's second serial to that serial's box", async (key, refused, fieldId) => {
    const message = await linesRefusal([GOOD, { ...GOOD, serials: [{ serial: "B" }, { serial: "C", ...refused }, { serial: "D" }] }, GOOD]);
    expect(message.startsWith(`lines.1.serials.1.${key}: `), message).toBe(true);
    expect(lineRefusalField(message, PAGE, ALL)).toBe(fieldId);
  });
});

describe("lineRefusalField: a row the page holds but no box it can find (owner answer 2, 2026-10-18)", () => {
  it.each(["x", "quantity"])("sends a held line's unknown key %s to that line's Part box", async (key) => {
    // The key's words are not read: no line key was renamed, so an unknown key is no old name.
    const message = await linesRefusal([GOOD, { ...GOOD, [key]: 3 }, GOOD]);
    expect(message).toBe(`lines.1: Unrecognized key: "${key}"`);
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-part");
  });

  it.each([
    [0, "entry-line-l2-serial-s1"],
    [1, "entry-line-l2-serial-s2"],
  ])("sends serial %i's unknown key to that serial's value box", async (index, fieldId) => {
    const serials = [{ serial: "B" }, { serial: "C" }, { serial: "D" }];
    serials[index] = { ...serials[index], x: 1 } as (typeof serials)[number];
    const message = await linesRefusal([GOOD, { ...GOOD, serials }, GOOD]);
    expect(message).toBe(`lines.1.serials.${index}: Unrecognized key: "x"`);
    expect(lineRefusalField(message, PAGE, ALL)).toBe(fieldId);
  });

  it("sends a serial the line does not hold to that line's Add serial(s) box", async () => {
    const message = await linesRefusal([GOOD, { ...GOOD, serials: [{ serial: "B" }, { serial: "C" }, { serial: "D" }, { serial: " " }] }, GOOD]);
    expect(message.startsWith("lines.1.serials.3.serial: "), message).toBe(true);
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-serials");
  });

  it("sends a path naming a prototype key to the held row's first box", () => {
    // Typed: the server refuses an unknown key one level up, so it never writes this path.
    expect(lineRefusalField("lines.1.constructor: x", PAGE, ALL)).toBe("entry-line-l2-part");
    expect(lineRefusalField("lines.1.serials.1.constructor: x", PAGE, ALL)).toBe("entry-line-l2-serial-s2");
  });
});

describe("lineRefusalField: a refusal that names no line the page holds (owner ruling, 2026-10-18)", () => {
  it.each([[[]], ["none"]])("sends a refusal of the line list itself (%j) to the lead line's Part box", async (lines) => {
    const message = await linesRefusal(lines);
    expect(message.startsWith("lines: "), message).toBe(true);
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l1-part");
  });

  it("sends a path to a line past the page's lines to the lead line's Part box", async () => {
    const message = await linesRefusal([GOOD, GOOD, GOOD, { ...GOOD, qty: 0 }]);
    expect(message.startsWith("lines.3.qty: "), message).toBe(true);
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l1-part");
  });

  it("sends a Line N past the page's lines to the lead line's Part box", async () => {
    const message = await partsRefusal(
      [fakePart("p1", "P-1"), fakePart("p2", "P-2"), fakePart("p3", "P-3")], lineInputs(4));
    expect(message).toBe("Line 4: that part does not exist");
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l1-part");
  });

  it("sends Line 0 to the lead line's Part box", () => {
    // Typed: the server counts lines from 1.
    expect(lineRefusalField("Line 0: that part does not exist", PAGE, ALL)).toBe("entry-line-l1-part");
  });

  it("answers null when the page holds no line", async () => {
    // The page always holds the lead line; nothing is chosen for a page that holds none.
    const message = await linesRefusal([{ ...GOOD, qty: 0 }]);
    expect(message.startsWith("lines.0.qty: "), message).toBe(true);
    expect(lineRefusalField(message, [], ALL)).toBeNull();
    expect(lineRefusalField("Line 1: that part does not exist", [], ALL)).toBeNull();
  });
});

describe("lineRefusalField: a Line N sentence, the box chosen from the words after the label", () => {
  it.each(["QTY-9", "WEIGHT-7", "SERIAL-1", "QUOTE-2", "QUANTITY-3"])(
    "sends line 2's inactive part %s to its Part box", async (partNumber) => {
      // The part number is the customer's to choose; it never picks the box.
      const message = await inactiveSecond(partNumber);
      expect(message).toBe(`Line 2 (ACME · ${partNumber}): that part is inactive`);
      expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-part");
    });

  it("sends line 2's part of another customer to its Part box", async () => {
    const message = await partsRefusal([
      fakePart("p1", "P-1"), fakePart("p2", "WEIGHT-7", { customerId: "cust-2" }), fakePart("p3", "P-3"),
    ]);
    expect(message).toBe("Line 2 (ACME · WEIGHT-7): that part belongs to another customer");
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-part");
  });

  it("sends line 2's missing part to its Part box", async () => {
    const message = await partsRefusal([fakePart("p1", "P-1"), fakePart("p3", "P-3")]);
    expect(message).toBe("Line 2: that part does not exist");
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-part");
  });

  it.each([
    ["a part number", "RACK): QTY-1", "ACME", "Line 2 (ACME · RACK): QTY-1): that part is inactive"],
    ["a customer code", "P-2", "Q): WEIGHT", "Line 2 (Q): WEIGHT · P-2): that part is inactive"],
    ["a part number holding another label", "Line 3 (QTY", "ACME", "Line 2 (ACME · Line 3 (QTY): that part is inactive"],
  ])("reads past %s that holds ): or a label", async (_what, partNumber, code, expected) => {
    const message = await inactiveSecond(partNumber, code);
    expect(message).toBe(expected);
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-part");
  });

  it("sends a label with no ): after it to that line's Part box", () => {
    // Typed: `lineLabel` always closes its parentheses before the sentence.
    expect(lineRefusalField("Line 2 (ACME · QTY-9", PAGE, ALL)).toBe("entry-line-l2-part");
  });

  it.each([
    // Typed in the server's words: the saved order's line refusals (order-edit.ts) and a create
    // warning (`buildWarnings`, order-create.ts), which New order never receives as a refusal, here
    // only to reach each word the scan reads.
    ["Line 2 (ACME · P-2): cannot reduce qty below 5 already shipped — Packing List 092826 — void the shipment first", "qty"],
    ["Line 2 (ACME · P-2): cannot reduce net weight below 12.5 lb already shipped — Packing List 092826 — void the shipment first", "weight"],
    ["Line 2 (ACME · P-2): serialization required but no serials entered", "serials"],
  ])("sends %s to the box its words name", (message, box) => {
    expect(lineRefusalField(message, PAGE, ALL)).toBe(`entry-line-l2-${box}`);
  });
});

describe("lineRefusalField: a refused quote link, in the server's words", () => {
  const QUOTE = {
    id: "q-1", quoteNumber: 7, status: "OPEN", deletedAt: null as Date | null, customerId: "cust-1",
    effectiveDate: new Date("2026-01-01T00:00:00Z"), expiryDate: new Date("2026-12-31T00:00:00Z"),
  };
  const ROW = { id: "ql-1", deletedAt: null as Date | null, partId: "p2" as string | null, quote: QUOTE };
  const RECEIVED = new Date("2026-06-01T00:00:00Z");

  /** `judgeQuoteLine`'s eight reasons (src/server/quote-links.ts), each with the row that yields it. */
  const REASONS: [string, unknown][] = [
    ["that quote line does not exist", null],
    ["Quote #7 has been deleted", { ...ROW, quote: { ...QUOTE, deletedAt: RECEIVED } }],
    ["Quote #7 no longer carries that line", { ...ROW, deletedAt: RECEIVED }],
    ["Quote #7 is closed", { ...ROW, quote: { ...QUOTE, status: "CLOSED" } }],
    ["Quote #7 belongs to another customer", { ...ROW, quote: { ...QUOTE, customerId: "cust-2" } }],
    ["Quote #7's line is free-text — attach its part on the quote before linking", { ...ROW, partId: null }],
    ["Quote #7's line quotes a different part", { ...ROW, partId: "p-9" }],
    ["Quote #7 is not in effect on 2026-06-01 (effective 2026-07-01 to 2026-12-31)",
      { ...ROW, quote: { ...QUOTE, effectiveDate: new Date("2026-07-01T00:00:00Z") } }],
  ];

  /** `resolveQuoteLinks`' refusal of line 2's link to `row`; lines 1 and 3 link nothing. */
  function quoteRefusal(row: unknown, parts = [fakePart("p1", "P-1"), fakePart("p2", "P-2"), fakePart("p3", "P-3")]): Promise<string> {
    const tx = { quoteLine: { findFirst: async () => row } } as unknown as Db;
    const lines = lineInputs(3).map((line, i) => (i === 1 ? { ...line, quoteLineId: "ql-1" } : line));
    return httpRefusal(() => resolveQuoteLinks(tx, "cust-1", RECEIVED, lines, resolved(parts)));
  }

  it.each(REASONS)("sends %s to line 2's quote box, or its Part box when no list is shown", async (reason, row) => {
    const message = await quoteRefusal(row);
    expect(message).toBe(`Line 2 (ACME · P-2): ${reason}`);
    const shown = recorder(true);
    expect(lineRefusalField(message, PAGE, shown.shown)).toBe("entry-line-l2-quote");
    expect(shown.asked).toEqual(["entry-line-l2-quote"]);
    const hidden = recorder(false);
    expect(lineRefusalField(message, PAGE, hidden.shown)).toBe("entry-line-l2-part");
    expect(hidden.asked).toEqual(["entry-line-l2-quote"]);
  });

  it("reads the words after a bare label", async () => {
    // Server code handed no part for line 2, so its label is bare. No caller passes that
    // (resolveQuoteLinks is given the parts resolveLineParts resolved), so the server never writes
    // a bare label before a quote reason; here to pin that a bare label's words are read too.
    const message = await quoteRefusal(REASONS[3][1], []);
    expect(message).toBe("Line 2: Quote #7 is closed");
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-quote");
    expect(lineRefusalField(message, PAGE, NONE)).toBe("entry-line-l2-part");
  });
});

describe("lineRefusalField: a serial entered twice", () => {
  it("sends the repeat to the first serial on the line whose trimmed value it names", async () => {
    // The server trims each serial in the parse, so it names `A`; the page holds `A ` and `A`.
    const message = await serialsRefusal([["LEAD-1"], ["B", "A ", "A"], []]);
    expect(message).toBe('Line 2 (ACME · P-2): serial "A" is entered twice');
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-serial-s2");
  });

  it("reads the label alone when the line's part is not named", async () => {
    // No caller hands createSerials no parts (order-create.ts and order-edit.ts pass the resolved
    // ones), so the server never writes a bare label before a serial entered twice.
    const message = await serialsRefusal([[], ["B", "A ", "A"], []], []);
    expect(message).toBe('Line 2: serial "A" is entered twice');
    expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-serial-s2");
  });

  /** The page's three lines, line 2 holding `values` as serials s1, s2, …. */
  const withSecondSerials = (values: string[]): RefusalLine[] =>
    [PAGE[0], { id: "l2", serials: values.map((serial, i) => ({ id: `s${i + 1}`, serial })) }, PAGE[2]];

  it("never takes a serial whose value the part number holds in quotes", async () => {
    // Compared whole, never searched for: `"B"` is in the message, but serial `B` is not the repeat.
    const message = await serialsRefusal([[], ["B", "A", "A"], []], [fakePart("p1", "P-1"), fakePart("p2", 'P "B"'), fakePart("p3", "P-3")]);
    expect(message).toBe('Line 2 (ACME · P "B"): serial "A" is entered twice');
    expect(lineRefusalField(message, withSecondSerials(["B", "A", "A"]), ALL)).toBe("entry-line-l2-serial-s2");
  });

  it("never takes a serial whose match leaves an unclosed label before it", async () => {
    // Serial `V` ends the message as a repeat would, but what it leaves before it is the label
    // and `: serial "K`, which does not end with the label's `)`.
    const repeat = 'K: serial "V';
    const message = await serialsRefusal([[], ["V", repeat, repeat], []]);
    expect(message).toBe('Line 2 (ACME · P-2): serial "K: serial "V" is entered twice');
    expect(lineRefusalField(message, withSecondSerials(["V", repeat, repeat]), ALL)).toBe("entry-line-l2-serial-s2");
  });

  it("never takes a serial whose match leaves something other than the label before it", async () => {
    // Serial `V` leaves `Line 2: serial "K)` before it, which ends with `)` but is neither the bare
    // label nor one opening with `Line 2 (`. No caller hands createSerials no parts (order-create.ts
    // and order-edit.ts pass the resolved ones), so the server never writes a bare label here.
    const repeat = 'K): serial "V';
    const message = await serialsRefusal([[], ["V", repeat, repeat], []], []);
    expect(message).toBe('Line 2: serial "K): serial "V" is entered twice');
    expect(lineRefusalField(message, withSecondSerials(["V", repeat, repeat]), ALL)).toBe("entry-line-l2-serial-s2");
  });

  it("accepts one ambiguity: a repeated serial holding ): serial \" and an earlier serial's value goes to that earlier serial", async () => {
    // The repeat is s2, but serial `V` (s1) leaves `Line 2 (ACME · P-2): serial "K)` before it,
    // which opens with `Line 2 (` and ends with `)` as a label does, and the first match on the line
    // is chosen. Accepted (see the leaf's header): it needs a serial value holding `): serial "`.
    const repeat = 'K): serial "V';
    const message = await serialsRefusal([[], ["V", repeat, repeat], []]);
    expect(message).toBe('Line 2 (ACME · P-2): serial "K): serial "V" is entered twice');
    expect(lineRefusalField(message, withSecondSerials(["V", repeat, repeat]), ALL)).toBe("entry-line-l2-serial-s1");
  });

  it.each([
    ["QUOTE-9", "a quote word"],
    ["X): QTY", "): and a quantity word"],
  ])("sends a repeated %s, which holds %s, to that serial's own box", async (value) => {
    const message = await serialsRefusal([[], ["B", value, value], []]);
    expect(message).toBe(`Line 2 (ACME · P-2): serial "${value}" is entered twice`);
    const page: RefusalLine[] = [PAGE[0], { id: "l2", serials: [{ id: "s1", serial: "B" }, { id: "s2", serial: value }, { id: "s3", serial: value }] }, PAGE[2]];
    expect(lineRefusalField(message, page, ALL)).toBe("entry-line-l2-serial-s2");
  });

  it.each(["Z", "QUOTE-9", "X): QTY"])(
    "sends a repeated %s the line does not hold to that line's Add serial(s) box (owner answer 2)", async (value) => {
      const message = await serialsRefusal([[], [value, value], []]);
      expect(message).toBe(`Line 2 (ACME · P-2): serial "${value}" is entered twice`);
      expect(lineRefusalField(message, PAGE, ALL)).toBe("entry-line-l2-serials");
    });

  it("never takes a blank serial for the repeat", () => {
    // Typed: the server refuses a blank serial in the parse, before any repeat is looked for, and a
    // blank serial is never a duplicate (owner answer 3, 2026-10-18).
    const page: RefusalLine[] = [PAGE[0], { id: "l2", serials: [{ id: "s1", serial: "B" }, { id: "s2", serial: "  " }] }];
    expect(lineRefusalField('Line 2 (ACME · P-2): serial "" is entered twice', page, ALL)).toBe("entry-line-l2-serials");
  });
});

describe("lineRefusalField: a refusal that is not about a part line", () => {
  it("answers null for the server's refusal of a container's or a charge's value", async () => {
    const container = await bodyRefusal({ containers: [{ typeId: "", count: 1 }] });
    expect(container.startsWith("containers.0.typeId: "), container).toBe(true);
    const charge = await bodyRefusal({ charges: [{ description: "Rush", amount: "25" }, { description: "Fee", amount: "-1" }] });
    expect(charge.startsWith("charges.1.amount: "), charge).toBe(true);
    expect(lineRefusalField(container, PAGE, ALL)).toBeNull();
    expect(lineRefusalField(charge, PAGE, ALL)).toBeNull();
  });

  it("answers null for the server's sentences that name no line", async () => {
    const onLine = await serialsRefusal([["A"], ["B", "C"], []]);
    expect(onLine).toBe("That serial is already on this line");
    const noSteps = await httpRefusal(() => lockCurrentRevision("p1", {
      $executeRaw: async () => 1, $queryRaw: async () => [],
    } as unknown as Db));
    expect(noSteps).toBe("This part has no process steps");
    const customer = await httpRefusal(() => defaultRequestDate("no-such-customer"));
    expect(customer).toBe("That customer does not exist");
    let date = "";
    try { parseDate("2026-13-01", "Received date"); } catch (err) { date = readableMessage(err); }
    expect(date).toBe('"2026-13-01" is not a valid date (yyyy-mm-dd) for Received date');
    for (const message of [onLine, noSteps, customer, date]) {
      expect(lineRefusalField(message, PAGE, ALL), message).toBeNull();
    }
  });

  it("reads the label as the server writes it, with a capital", () => {
    // Typed: `lineLabel` always writes `Line`.
    expect(lineRefusalField("line 2: that part is inactive", PAGE, ALL)).toBeNull();
  });

  it("reads only lineLabel's label, never another screen's Line N", () => {
    // Typed in the server's words: invoice finalize's refusal (invoices.ts), which New order never
    // receives. `Line 2` followed by ` · ` is not `lineLabel`'s label, so it names no part line.
    expect(lineRefusalField("Line 2 · P-2 — Harden needs a price — price every line before finalizing", PAGE, ALL)).toBeNull();
  });
});
