import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DISCOUNT_PERCENT, FINANCE_CHARGE, SALES_TAX_RATE } from "@/lib/rate-boxes";
import { BREAK_THRESHOLD, UNIT_PRICE } from "@/lib/price-boxes";
import { decimalBoxField, decimalField } from "@/server/decimal-field";
import { readableMessage } from "@/server/error-message";

const unitPrice = z.object({ unitPrice: decimalField(12, 4, { min: "nonnegative" }) }).strict();
const weight = z.object({ weight: decimalField(12, 2, { required: true, min: "positive" }) }).strict();
const amount = z.object({ amount: decimalField(12, 2, { required: true }) }).strict();

function refusal(schema: z.ZodType, body: unknown): string {
  const parsed = schema.safeParse(body);
  if (parsed.success) throw new Error(`accepted ${JSON.stringify(body)}`);
  return readableMessage(parsed.error);
}

describe("decimalField through the leaf", () => {
  it.each([[".36", 0.36], ["36.", 36], ["-.36", -0.36]])("accepts %j", (text, value) => {
    expect(amount.parse({ amount: text })).toEqual({ amount: value });
  });

  it.each([
    [unitPrice, { unitPrice: ".36" }, { unitPrice: 0.36 }],
    [weight, { weight: ".5" }, { weight: 0.5 }],
  ])("takes the owner's case", (schema, body, expected) => {
    expect(schema.parse(body)).toEqual(expected);
  });

  it.each([
    [unitPrice, { unitPrice: "$0.36" }, "unitPrice: enter a number without $ or commas, such as 0.36."],
    [unitPrice, { unitPrice: "+0.36" }, "unitPrice: enter a number without $ or commas, such as 0.36."],
    [unitPrice, { unitPrice: "0.36125" }, "unitPrice: use at most 4 digits after the point."],
    [unitPrice, { unitPrice: "123456789" }, "unitPrice: must be less than 100,000,000."],
    [unitPrice, { unitPrice: "-1" }, "unitPrice: cannot be negative."],
    [weight, { weight: "0" }, "weight: must be greater than zero."],
    [amount, { amount: "12345678901" }, "amount: must be between -10,000,000,000 and 10,000,000,000."],
  ])("refuses with the new sentence", (schema, body, sentence) => {
    expect(refusal(schema, body)).toBe(sentence);
  });

  it("keeps null and a missing key for an optional box", () => {
    expect(unitPrice.parse({ unitPrice: null })).toEqual({ unitPrice: null });
    expect(unitPrice.parse({})).toEqual({});
  });

  // Spec §5: every text accepted today is accepted with the same figure. The old pattern, copied
  // here on purpose (the sweep reads src/ only), against texts of every shape it took.
  it("accepts everything the old pattern accepted, with the same figure", () => {
    const old = (n: number, s: number) => new RegExp(`^-?\\d{1,${n}}(\\.\\d{1,${s}})?$`);
    const texts = ["0", "-0", "1", "36", "0.36", "0000.3600", "1234.5678", "12345.1", "-12.5",
      "99999999.9999", "9999999999.99", "0.0001", " 7 ", "10.10"];
    const boxes: [number, number][] = [[12, 4], [12, 2], [10, 4], [9, 6], [6, 4], [5, 2]];
    for (const [precision, scale] of boxes) {
      const field = decimalField(precision, scale);
      for (const text of texts) {
        if (!old(precision - scale, scale).test(text.trim())) continue;
        expect(field.parse(text)).toBe(Number(text.trim()));
      }
    }
  });
});

describe("decimalBoxField", () => {
  const price = z.object({ unitPrice: decimalBoxField(UNIT_PRICE.box) }).strict();
  const threshold = z.object({ threshold: decimalBoxField(BREAK_THRESHOLD.box, { required: true }) }).strict();

  it("reads a price box the way the screens do", () => {
    expect(price.parse({ unitPrice: ".36" })).toEqual({ unitPrice: 0.36 });
    expect(refusal(price, { unitPrice: "0.12345" })).toBe("unitPrice: use at most 4 digits after the point.");
  });

  it("refuses null and zero for a required positive box", () => {
    expect(threshold.safeParse({ threshold: null }).success).toBe(false);
    expect(refusal(threshold, { threshold: "0" })).toBe("threshold: must be greater than zero.");
  });
});

describe("decimalBoxField with a percent box", () => {
  it("keeps the plain not-a-figure sentence, whatever unit the screen's box has", () => {
    for (const rate of [SALES_TAX_RATE, FINANCE_CHARGE, DISCOUNT_PERCENT]) {
      const schema = z.object({ rate: decimalBoxField(rate.box) }).strict();
      expect(refusal(schema, { rate: "4%" })).toBe("rate: enter a number without $ or commas, such as 0.36.");
    }
  });
});
