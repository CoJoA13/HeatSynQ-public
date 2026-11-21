import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LinesSection } from "@/app/orders/[id]/LinesSection";
import { orderInvoiceGates } from "@/lib/order-invoice-gates";
import type { Gate } from "@/lib/permission-ui";
import type { OrderLine } from "../src/app/orders/[id]/page";

// An open quote re-pick under an edit gate that has since closed (#472), as the order hub's Lines
// section renders it. The re-pick takes no gate of its own, so the section mounts it only while
// its edit gate is open. tests/lines-section-wiring.test.ts pins that condition in the source; this
// file shows what it puts on screen.
//
// vitest has no DOM, so nothing here clicks "change". The line whose re-pick is open is injected
// through the `useState` seam below (the lines-section-offer.test.tsx precedent). A static render
// runs no effect, so a mounted re-pick shows its first state, "Checking quotes…", which nothing
// else in the section renders. The first case asserts that text for the seeded line, which is what
// proves the seam reached the state this comment says it does.

/** Substitutes which line's re-pick is open, for one render. It is the first `useState` of the
 *  section that starts as `null`; the re-pick's own two come later, in a child. */
const seeded = vi.hoisted(() => ({ repickLineId: null as string | null, taken: false }));
vi.mock("react", async original => {
  const real = await original<typeof import("react")>();
  return { ...real, useState: (initial: unknown) => {
    const state = real.useState(initial);
    if (initial === null && seeded.repickLineId !== null && !seeded.taken) {
      seeded.taken = true;
      return [seeded.repickLineId, state[1]];
    }
    return state;
  } };
});

const open: Gate = { allowed: true, disabled: false, title: undefined };
/** The hub's own Lines gate for order 1031 under a finalized invoice. */
const invoiced = orderInvoiceGates(open, 1031, "inv-1").linesGate;

function line(over: Partial<OrderLine>): OrderLine {
  return {
    id: "L1", position: 1, partId: "part-a", revisionNumber: 1, qty: 32, weight: 48,
    quoteLineId: null, quoteId: null, quoteNumber: null,
    part: { id: "part-a", partNumber: "P-A", name: "Shaft", customer: { code: "ACME" }, serializationRequired: false, eachWeight: 1.5 },
    ...over,
  };
}
const LEAD = line({});
const RIDER = line({ id: "L2", position: 2, partId: "part-b", revisionNumber: null });

/** The body rows of the lines table, in order, rendered with `repickLineId`'s re-pick open. */
function rows(repickLineId: string, editGate: Gate): string[] {
  seeded.repickLineId = repickLineId;
  seeded.taken = false;
  try {
    const html = renderToStaticMarkup(
      <LinesSection orderId="order-a" lines={[LEAD, RIDER]} shippedWeightByLineId={new Map()}
                    customerParts={[]} editGate={editGate} partsGate={open}
                    customerId="cust-1" receivedDate="2026-10-01" ordersViewAllowed
                    applyMutation={async () => {}} readAfterRemoval={async () => {}} />,
    );
    const body = /<tbody>(.*?)<\/tbody>/.exec(html);
    expect(body).not.toBeNull();
    return body![1].match(/<tr\b.*?<\/tr>/g) ?? [];
  } finally {
    seeded.repickLineId = null;
  }
}
const CHANGE = /<button\b[^>]*>change<\/button>/;

describe("LinesSection: an open quote re-pick and the edit gate (#472)", () => {
  it("under an open gate the opened line shows its re-pick, and the other line its change button", () => {
    const [lead, rider] = rows("L2", open);
    expect(rider).toContain("Checking quotes…");
    expect(rider).not.toMatch(CHANGE);
    expect(lead).not.toContain("Checking quotes…");
    const change = CHANGE.exec(lead);
    expect(change).not.toBeNull();
    expect(change![0]).not.toContain(' disabled=""');
    expect(change![0]).not.toContain("title=");
  });

  it("under a gate that has closed, the opened line shows the change button again, greyed and titled with the gate's reason", () => {
    const [lead, rider] = rows("L2", invoiced);
    expect(rider).not.toContain("Checking quotes…");
    for (const row of [lead, rider]) {
      const change = CHANGE.exec(row);
      expect(change).not.toBeNull();
      expect(change![0]).toContain(' disabled=""');
      expect(change![0]).toContain(
        'title="A line cannot be changed — Invoice 1031 is finalized; unlock it or raise a credit (see /invoicing/inv-1)"');
    }
  });
});
