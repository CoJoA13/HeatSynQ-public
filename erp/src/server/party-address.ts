/**
 * The default address of a kind, and the bill-to block every document prints (#671, owner ruling
 * R14 of 2026-10-22): when a customer's default BILL_TO address row carries a Name, the paper
 * stacks it ABOVE the customer's name, the quote's form, skipping it when it is blank or equal to
 * the customer's own name. Before this leaf the five readers had drifted three ways: the invoice
 * and the statement REPLACED the customer's name with the row's, the quote stacked, and the
 * shipping ticket's Sold To and the certification's To ignored the row's name.
 *
 * A dependency-free leaf, the `order-locks.ts` / `invoice-guards.ts` precedent: no Prisma, no
 * permission, no service import, so any reader can state the rule once. The invoice reads it at
 * CREATE and freezes the lines into its snapshot (frozen paper: invoices raised before the rule
 * keep what they printed); the statement, the quote, the ticket and the certification read it
 * live at each build. The SHIP-TO rule is deliberately NOT here: a ship-to row's name prints
 * alone, else the customer's (the invoice's `renderAddress`, the ticket's and the bill of lading's
 * ship-to), and the issue left it as it is. Which row an invoice's ship-to is, the latest
 * shipment's (#1055), is `src/lib/invoice-ship-to.ts`'s.
 */

type PartyRow = { name: string; street: string; city: string; state: string; zip: string };

/** The default row of `kind`, else the first one of that kind, else null, never another kind's. */
export function pickDefaultAddress<T extends { kind: string; isDefault: boolean }>(
  addresses: readonly T[], kind: T["kind"],
): T | null {
  const of = addresses.filter((a) => a.kind === kind);
  return of.find((a) => a.isDefault) ?? of[0] ?? null;
}

/** "City, ST zip", each part dropped when blank; "" when all three are. */
export function cityLine(addr: Pick<PartyRow, "city" | "state" | "zip">): string {
  return [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

/** R14's name to stack above the customer's: the row's name when it names something else, "" when
 *  the row has none, is blank or repeats the customer's name (an exact comparison, as the quote's). */
export function billToAttn(customerName: string, addr: Pick<PartyRow, "name"> | null): string {
  return addr !== null && addr.name !== "" && addr.name !== customerName ? addr.name : "";
}

/** The bill-to block's lines: the stacked name when there is one, the customer's name, the street
 *  and the city line, blank lines dropped so none prints empty. */
export function billToLines(customerName: string, addr: PartyRow | null): string[] {
  const attn = billToAttn(customerName, addr);
  const city = addr ? cityLine(addr) : "";
  return [
    ...(attn !== "" ? [attn] : []),
    customerName,
    ...(addr?.street ? [addr.street] : []),
    ...(city !== "" ? [city] : []),
  ];
}
