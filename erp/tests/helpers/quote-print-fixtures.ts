import { prisma } from "./db";
import { runWithContext } from "@/server/context";
import { createQuote } from "@/server/quotes";
import { createSurcharge } from "@/server/surcharges";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { QUOTE_DEFAULT_CONFIG } from "@/lib/template-contracts/index";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import { layoutOf, logo } from "./canvas-fixtures";
import { standardQuoteLayout } from "./quote-canvas-fixtures";
import type { Customer, User } from "../../prisma/generated/prisma/client";

/**
 * The customers, bill-to rows, signers, step codes and quotes the quote's canvas cases print (since
 * quote canvas PR 2: the seed's picked quotes; the print path and the budget, which extend this file: Admin's surcharges and
 * the published templates). The
 * shapes are tests/quote-templates.test.ts's and tests/quote-pdf.test.ts's, copied once here (those
 * files keep their own and are not edited): a customer on terms of its own, its default BILL_TO row,
 * a signer with a title, a step code per price row, and a quote through `createQuote`. Every write
 * runs as the system actor.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let seq = 0;

/** A live customer on terms of its own (`QCP<n>` / "Quote Canvas Customer <n>"), opted out of every
 *  surcharge when `surchargeOptOut`. */
export async function makeCustomer(opts: { surchargeOptOut?: boolean } = {}): Promise<Customer> {
  seq += 1;
  const n = seq;
  return asSystem(async () => {
    const terms = await prisma.terms.create({ data: { name: `Net ${n}`, netDays: 30 } });
    return prisma.customer.create({
      data: {
        code: `QCP${n}`, name: `Quote Canvas Customer ${n}`, termsId: terms.id,
        surchargeOptOut: opts.surchargeOptOut ?? false,
      },
    });
  });
}

/** The customer's default BILL_TO row (its name blank unless given, so the customer's name prints
 *  alone over the address, R14). */
export async function makeBillTo(customerId: string, opts: { name?: string; street?: string } = {}): Promise<void> {
  await asSystem(() => prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: opts.name ?? "", street: opts.street ?? "700 Demo Drive",
      city: "Chicago", state: "IL", zip: "12345", isDefault: true,
    },
  }));
}

/** A signer with a title (ruling 14's name and title lines). */
export async function makeQuotedBy(): Promise<User> {
  seq += 1;
  return asSystem(() => prisma.user.create({
    data: { username: `qcsales${seq}`, displayName: "Mr. Johnathen Smith", passwordHash: "x", title: "V.P. Sales" },
  }));
}

/** A process step code named `name`. */
export async function makeStepCode(name: string): Promise<{ id: string }> {
  seq += 1;
  return asSystem(() => prisma.processStepCode.create({ data: { code: `QCS${seq}`, name }, select: { id: true } }));
}

/** A quote of `lines` lines (default 1), each with `prices` price rows (default 1: EACH; 2 adds an LB
 *  row with two breaks), through `createQuote`. */
export async function quoteFor(
  customer: Customer, opts: { lines?: number; prices?: 1 | 2 } = {},
): Promise<{ id: string; quoteNumber: number }> {
  const quotedBy = await makeQuotedBy();
  const each = await makeStepCode("Bake");
  const lb = opts.prices === 2 ? await makeStepCode("Temper") : null;
  const prices = [
    { processStepCodeId: each.id, setupCharge: "2.00", unitPrice: "0.1500", minimumCharge: "100.00", pricePer: "EACH" },
    ...(lb === null ? [] : [{
      processStepCodeId: lb.id, unitPrice: "0.0800", pricePer: "LB",
      breaks: [{ threshold: "1000", price: "0.0700" }, { threshold: "5000", price: "0.0600" }],
    }]),
  ];
  const lines = Array.from({ length: opts.lines ?? 1 }, (_, i) => ({
    partNumberText: `P-${String(i + 1).padStart(4, "0")}`, partNameText: "Customer part name",
    materialText: "Customer Material", eachWeight: "10", quotedQty: 100, prices,
  }));
  const quote = await asSystem(() => createQuote({
    customerId: customer.id, quotedById: quotedBy.id, rfqNumber: "12345", notes: "Our terms are net 30", lines,
  }));
  return { id: quote.id, quoteNumber: quote.quoteNumber };
}

/** A PERCENT surcharge on Admin's list, scope ALL (tests/quote-pdf.test.ts's shape); `rate` is the
 *  stored fraction (`"0.040000"` is 4%). */
export async function makeSurcharge(name: string, rate: string): Promise<{ id: string }> {
  return asSystem(() => createSurcharge({ name, kind: "PERCENT", rate, position: 1, scope: "ALL" }));
}

/** A published QUOTE template holding `layout` (null: a flow template), `config.logo` null, its version
 *  carrying `logo` bytes when given, assigned to each of `customerIds`; answers the published version id. */
export async function publishQuoteTemplate(
  name: string, customerIds: string[], layout: CanvasLayout | null, logoBytes?: Buffer,
): Promise<string> {
  const t = await asSystem(() => createTemplate("QUOTE", name));
  const config: TemplateConfig = { ...structuredClone(QUOTE_DEFAULT_CONFIG), logo: null, layout };
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  if (logoBytes !== undefined) await asSystem(() => uploadLogo(t.id, logoBytes, "image/png"));
  const { versionId } = await asSystem(() => publishDraft(t.id));
  for (const customerId of customerIds) await asSystem(() => assignTemplate(customerId, "QUOTE", t.id));
  return versionId;
}

/** `standardQuoteLayout()` plus a page-top Logo item at x 24, y 24, 36 × 36: left of the centre column
 *  (x 202) and above the parties (101). Square, so the square fixture image fills the box. */
export function quoteLayoutWithLogo(): CanvasLayout {
  return layoutOf([...standardQuoteLayout().items, logo({ box: { x: 24, y: 24, w: 36, h: 36 } })]);
}
