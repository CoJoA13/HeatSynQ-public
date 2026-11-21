import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceFreezeNotice } from "@/app/shipping/[id]/ShipmentDetail";
import { NOTICE } from "@/lib/ui-classes";

// #472, owner ruling 2026-10-08: on a shipment with a finalized invoice the page shows one amber
// line that names the invoice and links to it. A control's title cannot hold a link, and this
// sentence is new wording, so it is pinned here word for word.
//
// WHEN the line shows is `invoiceNotice`'s decision (tests/shipment-gates.test.ts), and that the
// page asks it is tests/shipment-detail-wiring.test.ts's. This file is the markup alone. No DOM
// here (vitest runs in node), so the line on the real page is Playwright's to read
// (e2e/flows/reverse-shipment.mjs, which checks its words and its link's href and does not click).

const render = () => renderToStaticMarkup(
  <InvoiceFreezeNotice invoice={{ orderId: "ord-1", orderNumber: 300, invoiceId: "inv-1" }} />,
);

describe("the invoice freeze's amber line (#472)", () => {
  it("reads the ruled sentence, word for word", () => {
    expect(render().replace(/<[^>]+>/g, "")).toBe(
      "Invoice 300 is finalized — lines, added orders and billed freight on this shipment are frozen. "
      + "Unlock the invoice, raise a credit, or reverse this shipment.");
  });

  it("links the invoice's own page from the words that name it", () => {
    const anchors = render().match(/<a\b[^>]*>[^<]*<\/a>/g) ?? [];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toContain('href="/invoicing/inv-1"');
    expect(anchors[0]).toMatch(/>Invoice 300<\/a>$/);
  });

  it("is one amber paragraph, styled as the reversal-pair banner is", () => {
    const html = render();
    expect(html.startsWith(`<p class="${NOTICE.warning} mb-3">`)).toBe(true);
    expect(html.endsWith("</p>")).toBe(true);
  });
});
