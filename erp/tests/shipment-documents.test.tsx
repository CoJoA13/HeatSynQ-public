import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShipmentDocumentsTable } from "@/app/shipping/[id]/ShipmentDetail";

const orders = [
  { orderId: "order-b", label: "1014-3" },
  { orderId: "order-a", label: "1013-1" },
];
const document = (id: string, orderId: string | null, kind = "SHIPPER") => ({
  id, kind, orderId, createdAt: "2026-09-08T12:00:00.000Z",
});

describe("shipment document scope (#231)", () => {
  it.each([
    { id: "ticket-a", orderId: "order-a", label: "1013-1" },
    { id: "ticket-b", orderId: "order-b", label: "1014-3" },
  ])("names $label by order ID, not array position", ({ id, orderId, label }) => {
    const html = renderToStaticMarkup(<ShipmentDocumentsTable docs={[document(id, orderId)]} orders={orders} />);
    expect(html).toContain(`<td>Order ${label}</td>`);
    expect(html).toContain(`href="/api/documents/${id}"`);
  });

  it.each(["SHIPPER", "BOL"])("keeps Whole shipment on a whole-set %s", (kind) => {
    const html = renderToStaticMarkup(
      <ShipmentDocumentsTable docs={[document("whole", null, kind)]} orders={orders} />,
    );
    expect(html).toContain("<td>Whole shipment</td>");
    expect(html).not.toContain("<td>Order ");
  });

  it("keeps an unmatched legacy ticket available without inventing an order label", () => {
    const html = renderToStaticMarkup(
      <ShipmentDocumentsTable docs={[document("legacy-ticket", "missing-order")]} orders={orders} />,
    );
    expect(html).toContain("<td>One order (details unavailable)</td>");
    expect(html).toContain('href="/api/documents/legacy-ticket"');
    expect(html).not.toContain("1013-1");
    expect(html).not.toContain("1014-3");
  });

  it("does not call a scoped ticket Whole shipment when no membership data is available", () => {
    const html = renderToStaticMarkup(
      <ShipmentDocumentsTable docs={[document("old-ticket", "order-a")]} orders={[]} />,
    );
    expect(html).toContain("<td>One order (details unavailable)</td>");
    expect(html).toContain('href="/api/documents/old-ticket"');
  });
});
