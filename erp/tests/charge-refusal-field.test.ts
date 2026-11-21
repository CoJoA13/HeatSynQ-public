import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { readableMessage } from "@/server/error-message";
import { createOrder } from "@/server/order-create";
import { CHARGE_ITEM } from "@/server/order-internals";
import { CHARGE_KEY_BOXES, chargeRefusalField } from "@/lib/charge-refusal-field";

// Where New order takes the operator when the SERVER refuses a charge's value (#546): the refused
// charge's own box on the Order details tab, read from the path the server names. Each path
// refusal is produced by the server's own code: `createOrder` refuses its body before it reads
// anything, and `readableMessage` is what `handle()` answers for that refusal. Typed, and said so
// at its case: a path naming a prototype key (the server refuses an unknown key one level up) and
// a part line's `Line N` sentence, which the charge leaf only has to leave alone.

/** Three charges, as the page holds them, and the page's lead part line. */
const CHARGES = ["c1", "c2", "c3"];
const LEAD = "l1";

/** A charge and a part line the create schema takes. */
const GOOD = { description: "Rush", amount: "25" };
const LINE = { partId: "part-1", qty: 30, weight: "75" };

/** What the server answers to a create of `body`, over one good part line, in `handle()`'s words. */
async function bodyRefusal(body: Record<string, unknown>): Promise<string> {
  const err = await createOrder({ customerId: "cust-1", lines: [LINE], ...body }).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ZodError);
  return readableMessage(err);
}

/** What the server answers to a create whose charges are `charges`. */
const chargesRefusal = (charges: unknown) => bodyRefusal({ charges });

/** A box on the Order details tab. */
const details = (fieldId: string) => ({ tab: "details", fieldId });

describe("chargeRefusalField: the server's keys", () => {
  it("has a box for every key of the server's charge", () => {
    // A key the server adds or renames without a box here would go to the charge's Description.
    expect(Object.keys(CHARGE_KEY_BOXES).sort()).toEqual(Object.keys(CHARGE_ITEM.shape).sort());
  });
});

describe("chargeRefusalField: the refused charge's box, from the server's path", () => {
  it.each([
    ["description", { description: "  " }, "description"],
    ["amount", { amount: "-1" }, "amount"],
  ])("sends a refused %s on the second charge to that charge's box on Order details", async (key, refused, box) => {
    const message = await chargesRefusal([GOOD, { ...GOOD, ...refused }, GOOD]);
    expect(message.startsWith(`charges.1.${key}: `), message).toBe(true);
    expect(chargeRefusalField(message, CHARGES, LEAD)).toEqual(details(`entry-charge-c2-${box}`));
  });

  it("sends a held charge's unknown key to that charge's Description (owner answer 2, 2026-10-18)", async () => {
    const message = await chargesRefusal([GOOD, { ...GOOD, price: "25" }, GOOD]);
    expect(message).toBe('charges.1: Unrecognized key: "price"');
    expect(chargeRefusalField(message, CHARGES, LEAD)).toEqual(details("entry-charge-c2-description"));
  });

  it("sends a path naming a prototype key to the held charge's Description", () => {
    // Typed: the server refuses an unknown key one level up, so it never writes this path.
    expect(chargeRefusalField("charges.1.constructor: x", CHARGES, LEAD)).toEqual(details("entry-charge-c2-description"));
  });
});

describe("chargeRefusalField: a refusal that names no charge the page holds", () => {
  it("sends a refusal of the charge list itself to the first charge's Description (owner ruling, 2026-10-18)", async () => {
    const message = await chargesRefusal("none");
    expect(message.startsWith("charges: "), message).toBe(true);
    expect(chargeRefusalField(message, CHARGES, LEAD)).toEqual(details("entry-charge-c1-description"));
  });

  it("sends a charge past the page's charges to the first charge's Description (owner ruling, 2026-10-18)", async () => {
    const message = await chargesRefusal([GOOD, GOOD, GOOD, { ...GOOD, amount: "-1" }]);
    expect(message.startsWith("charges.3.amount: "), message).toBe(true);
    expect(chargeRefusalField(message, CHARGES, LEAD)).toEqual(details("entry-charge-c1-description"));
  });

  it("sends a charge refusal on a page holding no charge to the lead line's Part box on Parts (owner answer 4, 2026-10-18)", async () => {
    const one = await chargesRefusal([{ ...GOOD, amount: "-1" }]);
    expect(one.startsWith("charges.0.amount: "), one).toBe(true);
    const list = await chargesRefusal("none");
    for (const message of [one, list]) {
      expect(chargeRefusalField(message, [], LEAD)).toEqual({ tab: "parts", fieldId: "entry-line-l1-part" });
    }
  });
});

describe("chargeRefusalField: a refusal that is not about a charge", () => {
  it("answers null for the server's refusal of a part line's or a container's value", async () => {
    const line = await bodyRefusal({ lines: [LINE, { ...LINE, qty: 0 }] });
    expect(line.startsWith("lines.1.qty: "), line).toBe(true);
    const container = await bodyRefusal({ containers: [{ typeId: "steel", count: 0 }] });
    expect(container.startsWith("containers.0.count: "), container).toBe(true);
    expect(chargeRefusalField(line, CHARGES, LEAD)).toBeNull();
    expect(chargeRefusalField(container, CHARGES, LEAD)).toBeNull();
    expect(chargeRefusalField(line, [], LEAD)).toBeNull();
  });

  it("answers null for a part line's sentence that holds the word", () => {
    // Typed in the server's words (`lineLabel`, src/server/order-internals.ts).
    expect(chargeRefusalField("Line 2 (ACME · CHARGES-1): that part is inactive", CHARGES, LEAD)).toBeNull();
  });
});
