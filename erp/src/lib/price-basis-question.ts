// The question a basis change asks (PR 3's words on the quote page, read by the part's Pricing too;
// owner, 2026-11-01 on #824): moving a row among the non-Lot bases while it has breaks silently
// changes what every stored number means, so warn, don't refuse, don't re-derive. Lot with breaks
// stays the server's refusal, shown verbatim. Client-safe.
import { PRICE_PER_LABELS, type PricePerValue } from "./part-constants";

export function priceBasisAsks(from: PricePerValue, to: PricePerValue, breakCount: number): boolean {
  return breakCount > 0 && from !== "LOT" && to !== "LOT";
}

export function priceBasisQuestion(from: PricePerValue, to: PricePerValue, breakCount: number): { title: string; body: string; confirm: string } {
  return {
    title: `Read this operation's prices as ${PRICE_PER_LABELS[to]}?`,
    body: `This operation has ${breakCount} price break(s). Its Unit price, and every ` +
      `break's own threshold and price, are all read today as ${PRICE_PER_LABELS[from]} ` +
      `amounts. Switching to ${PRICE_PER_LABELS[to]} does not change any of those stored ` +
      `numbers — every one of them will be read as a ${PRICE_PER_LABELS[to]} amount from now on.`,
    confirm: `Change to ${PRICE_PER_LABELS[to]}`,
  };
}
