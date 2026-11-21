import { beforeEach, expect, it } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { drawnText, textRunsWithY } from "./helpers/pdf";
import { GET } from "@/app/api/parts/[id]/process/preview-contexts/route";
import { readProcessDocument } from "@/server/process-document";
import { POST } from "@/app/api/parts/[id]/process/preview/route";
const params = { params: Promise.resolve({ id: "missing" }) };
beforeEach(truncateAll);
/** A part whose lead-line order 4567 has one load, and whose customer has a received-from address and a phone. */
async function routeFixture() {
  const customer = await prisma.customer.create({ data: { code: "ROUTE", name: "Route fixture", phone: "555-0161" } });
  await prisma.customerAddress.create({ data: { customerId: customer.id, kind: "RECEIVED_FROM", street: "61 Route Street", city: "Fixture City", state: "AL", zip: "35002", isDefault: true } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "RT-6100", eachWeight: 1 } });
  const order = await prisma.order.create({ data: { customerId: customer.id, orderNumber: 4567, receivedDate: new Date(), requestDate: new Date(), lines: { create: { partId: part.id, position: 1, qty: 1, weight: 1 } }, loads: { create: { loadNumber: 1, qty: 1, weight: 1 } } } });
  const baseline = await readProcessDocument(part.id);
  const post = (cookie: string, context: unknown, generation = 1) => POST(new Request("http://t", { method: "POST", headers: { cookie },
    body: JSON.stringify({ expectedBaselineToken: baseline.baselineToken, steps: [], generation, context }) }), { params: Promise.resolve({ id: part.id }) });
  return { part, order, post, parameters: { params: Promise.resolve({ id: part.id }) }, orderContext: { orderId: order.id, orderNumber: 4567, loadNumber: 1 } };
}
it("reading contexts needs all three read permissions; a preview needs parts.view and processes.view before its body is read", async () => {
  expect((await GET(new Request("http://t"), params)).status).toBe(401);
  expect((await POST(new Request("http://t", { method: "POST", body: "invalid" }), params)).status).toBe(401);
  const permissions = ["parts.view", "processes.view", "orders.view"];
  for (const missing of permissions) {
    const cookie = await signInWith(permissions.filter(p => p !== missing), missing);
    expect((await GET(new Request("http://t", { headers: { cookie } }), params)).status).toBe(403);
    // Once the gates pass, an unparseable body is a 400; so a 403 was decided before the body was
    // read. orders.view is not a gate of its own: a SAMPLE preview needs none (spec 2026-09-26 §5).
    expect((await POST(new Request("http://t", { method: "POST", headers: { cookie }, body: "invalid" }), params)).status).toBe(missing === "orders.view" ? 400 : 403);
  }
});
it("parts.view and processes.view alone preview a SAMPLE but not an order, and customers.view adds the received-from contact", async () => {
  const f = await routeFixture();
  const partsOnly = await signInWith(["parts.view", "processes.view"], "sample-only");
  const sample = await f.post(partsOnly, null, 43);
  expect(sample.status).toBe(200);
  expect(sample.headers.get("content-type")).toBe("application/pdf");
  expect(sample.headers.get("cache-control")).toBe("no-store");
  expect(sample.headers.get("X-Preview-Sample")).toBe("1");
  expect(sample.headers.get("X-Preview-Generation")).toBe("43");
  expect(sample.headers.get("X-Preview-Page-Count")).toBe("1");
  expect(sample.headers.get("X-Preview-Template-Id")).toBeTruthy();
  const pdf = Buffer.from(await sample.arrayBuffer());
  expect(textRunsWithY(pdf)[0].filter(r => r.text === "SAMPLE")).toHaveLength(3);
  const text = drawnText(pdf);
  expect(text).toContain("RT-6100"); expect(text).toContain("Route fixture");
  expect(text).not.toContain("61 Route Street"); expect(text).not.toContain("555-0161");
  // The service's own refusal, not a route gate's: the route never requires orders.view outright.
  const refused = await f.post(partsOnly, f.orderContext);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "Previewing an order needs orders.view access" });
  const withCustomers = await signInWith(["parts.view", "processes.view", "customers.view"], "sample-contact");
  const contact = drawnText(Buffer.from(await (await f.post(withCustomers, null)).arrayBuffer()));
  expect(contact).toContain("61 Route Street"); expect(contact).toContain("555-0161");
  const noProcesses = await signInWith(["parts.view", "orders.view", "customers.view"], "no-processes");
  expect((await f.post(noProcesses, null)).status).toBe(403);
  expect((await f.post(noProcesses, f.orderContext)).status).toBe(403);
});
it("bounds UTF-8 bytes and rejects malformed UTF-8, a missing context and invalid generation/load without rendering", async () => {
  const cookie = await signInWith(["parts.view", "processes.view", "orders.view"]);
  const request = (body: BodyInit) => new Request("http://t", { method: "POST", headers: { cookie }, body });
  expect((await POST(request(" ".repeat(1024 * 1024 + 1)), params)).status).toBe(413);
  expect((await POST(request("é".repeat(524289)), params)).status).toBe(413);
  expect((await POST(request(new Uint8Array([0xff])), params)).status).toBe(400);
  expect((await POST(request(" ".repeat(1024 * 1024)), params)).status).toBe(400);
  for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const context of [{ orderId: "x", orderNumber: 1, loadNumber: 1 }, null]) {
      expect((await POST(request(JSON.stringify({ expectedBaselineToken: "x", steps: [], generation, context })), params)).status).toBe(400);
    }
  }
  expect((await POST(request(JSON.stringify({ expectedBaselineToken: "x", steps: [], generation: 1, context: { orderId: "x", orderNumber: 1 } })), params)).status).toBe(400);
  // `context` is required: SAMPLE is asked for with null, so a request that forgot its context is
  // a 400 rather than a SAMPLE (which, for this missing part, would be a 404).
  expect((await POST(request(JSON.stringify({ expectedBaselineToken: "x", steps: [], generation: 1 })), params)).status).toBe(400);
  expect((await POST(request(JSON.stringify({ expectedBaselineToken: "x", steps: [], generation: 1, context: null })), params)).status).toBe(404);
});

it("returns no-store PDF with integer generation and page-count headers for one existing load", async () => {
  const f = await routeFixture();
  const cookie = await signInWith(["parts.view", "processes.view", "orders.view"]);
  const contexts = await GET(new Request("http://t", { headers: { cookie } }), f.parameters);
  expect(contexts.headers.get("cache-control")).toBe("no-store");
  expect((await contexts.json()).items).toEqual([f.orderContext]);
  const response = await f.post(cookie, f.orderContext, 42);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("X-Preview-Generation")).toBe("42");
  expect(response.headers.get("X-Preview-Page-Count")).toBe("1");
  expect(response.headers.get("X-Preview-Sample")).toBe("0");
  expect(response.headers.get("X-Preview-Template-Id")).toBeTruthy();
  expect(response.headers.get("X-Preview-Template-Name")).toBeTruthy();
  const resolved = await prisma.documentTemplate.findFirstOrThrow({ where: { id: response.headers.get("X-Preview-Template-Id")! } });
  expect(decodeURIComponent(response.headers.get("X-Preview-Template-Name")!)).toBe(resolved.name);
  expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
});
