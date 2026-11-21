import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db";
import { readableMessage } from "@/server/error-message";
import { createOrder } from "@/server/order-create";
import { CONTAINER_ITEM } from "@/server/order-internals";
import { assertRefExists } from "@/server/reference-guards";
import { ADD_CONTAINER_ID, CONTAINER_KEY_BOXES, containerRefusalField } from "@/lib/container-refusal-field";

// Where New order takes the operator when the SERVER refuses a container value (#494): the
// refused row's own box, read from the path the server names. The page's own checks refuse the
// same values first, so this is reached only when the two disagree. Each refusal of a body is
// produced by the server's own code: `createOrder` refuses its body before it reads anything, and
// `readableMessage` is what `handle()` answers for that refusal. So is the deleted-type refusal
// (`assertRefExists`). Three sentences the server writes only inside its transaction, after reads
// a test without seeded rows cannot pass, are typed in the server's words: a part line's
// (`lineLabel`), the customer's, and a date's (`parseDate`), all in `order-internals.ts` and
// `order-create.ts`.

/** Three container rows, as the page holds them. */
const ROWS = ["c1", "c2", "c3"];

/** A container row the create schema takes. */
const GOOD = { typeId: "steel", count: 2 };

/** A part line the create schema takes. */
const LINE = { partId: "part-1", qty: 30, weight: "75" };

/** What the server answers to a create of `body`, over one good part line, in `handle()`'s words. */
async function bodyRefusal(body: Record<string, unknown>): Promise<string> {
  const err = await createOrder({ customerId: "cust-1", lines: [LINE], ...body }).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ZodError);
  return readableMessage(err);
}

/** What the server answers to a create whose container rows are `containers`. Everything but the
 *  containers passes the schema, so the refusal is about a container. */
const serverRefusal = (containers: unknown) => bodyRefusal({ containers });

describe("containerRefusalField: the server's keys", () => {
  it("has a box for every key of the server's container row", () => {
    // A key the server adds or renames without a box here would fall back to a word scan of the
    // message, and from there to the Type box.
    expect(Object.keys(CONTAINER_KEY_BOXES).sort()).toEqual(Object.keys(CONTAINER_ITEM.shape).sort());
  });
});

describe("containerRefusalField: the refused row's box, from the server's path", () => {
  // One refused value per key of the server's row, each with its own box.
  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["typeId", { typeId: "" }, "type"],
    ["count", { count: 0 }, "count"],
    ["pieces", { pieces: 0 }, "pieces"],
    ["tareEach", { tareEach: "-1" }, "tareEach"],
    ["scaleGross", { scaleGross: "1.234" }, "scaleGross"],
    ["customerContainerId", { customerContainerId: "X".repeat(61) }, "customerContainerId"],
  ];

  it.each(REFUSED)("sends a refused %s on the second row to that row's box", async (key, refused, box) => {
    const message = await serverRefusal([GOOD, { ...GOOD, ...refused }, GOOD]);
    expect(message.startsWith(`containers.1.${key}: `), message).toBe(true);
    expect(containerRefusalField(message, ROWS)).toBe(`entry-container-c2-${box}`);
  });

  it.each(REFUSED)("sends a refused %s on the first row to the first row's box", async (key, refused, box) => {
    const message = await serverRefusal([{ ...GOOD, ...refused }, GOOD, GOOD]);
    expect(containerRefusalField(message, ROWS)).toBe(`entry-container-c1-${box}`);
  });

  it.each(REFUSED)("sends a refused %s on the last row to the last row's box", async (key, refused, box) => {
    const message = await serverRefusal([GOOD, GOOD, { ...GOOD, ...refused }]);
    expect(containerRefusalField(message, ROWS)).toBe(`entry-container-c3-${box}`);
  });

  it.each([
    ["qty", 1, "entry-container-c2-pieces"],
    ["tareWeight", "40", "entry-container-c2-tareEach"],
    ["grossWeight", "400", "entry-container-c2-scaleGross"],
  ])("sends the old key %s on the second row to the box that took its place", async (key, value, fieldId) => {
    // The server names the row and quotes the key it does not know; the key's words lead to the box.
    const message = await serverRefusal([GOOD, { ...GOOD, [key]: value }]);
    expect(message).toBe(`containers.1: Unrecognized key: "${key}"`);
    expect(containerRefusalField(message, ROWS)).toBe(fieldId);
  });

  it("sends a refusal that names the row and no key or known word to the row's Type box", async () => {
    const message = await serverRefusal([GOOD, { ...GOOD, colour: "red" }]);
    expect(message).toBe('containers.1: Unrecognized key: "colour"');
    expect(containerRefusalField(message, ROWS)).toBe("entry-container-c2-type");
  });
});

describe("containerRefusalField: a refusal that names no row", () => {
  it("sends the server's refusal of a deleted container type to Add container", async () => {
    // The type was deleted while the page was open. The server names no row, and the page cannot
    // tell which rows hold that type (owner ruling, 2026-10-15).
    const err = await assertRefExists("containerType", "no-such-type", prisma).then(() => null, (e: unknown) => e);
    const message = readableMessage(err);
    expect(message).toBe("That container type does not exist");
    expect(containerRefusalField(message, ROWS)).toBe(ADD_CONTAINER_ID);
    expect(containerRefusalField(message, [])).toBe(ADD_CONTAINER_ID);
  });

  it("sends a row the page no longer holds to Add container", async () => {
    const fourth = await serverRefusal([GOOD, GOOD, GOOD, { ...GOOD, count: 0 }]);
    expect(fourth.startsWith("containers.3.count: "), fourth).toBe(true);
    expect(containerRefusalField(fourth, ROWS)).toBe(ADD_CONTAINER_ID);
    const first = await serverRefusal([{ ...GOOD, count: 0 }]);
    expect(containerRefusalField(first, [])).toBe(ADD_CONTAINER_ID);
  });

  it("sends a refusal of the container list itself to Add container", async () => {
    const message = await serverRefusal("none");
    expect(message.startsWith("containers: "), message).toBe(true);
    expect(containerRefusalField(message, ROWS)).toBe(ADD_CONTAINER_ID);
  });
});

describe("containerRefusalField: a refusal that is not about a container row", () => {
  it("answers null for the server's refusal of a part line's or a charge's value", async () => {
    const line = await bodyRefusal({ lines: [LINE, { ...LINE, qty: 0 }] });
    expect(line.startsWith("lines.1.qty: "), line).toBe(true);
    const charge = await bodyRefusal({ charges: [{ description: "Rush", amount: "-1" }] });
    expect(charge.startsWith("charges.0.amount: "), charge).toBe(true);
    expect(containerRefusalField(line, ROWS)).toBeNull();
    expect(containerRefusalField(charge, ROWS)).toBeNull();
  });

  it.each([
    // A part line's own label can hold the word: its part number is the customer's to choose.
    "Line 2 (ACME · CONTAINER-9): that part is inactive",
    "That customer does not exist",
    '"2026-13-01" is not a valid date (yyyy-mm-dd) for Received date',
  ])("answers null for %s, in the server's words", (message) => {
    expect(containerRefusalField(message, ROWS)).toBeNull();
  });
});
