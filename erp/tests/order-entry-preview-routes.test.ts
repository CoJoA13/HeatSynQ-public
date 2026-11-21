import { beforeEach, describe, expect, it } from "vitest";
import { prisma, seedOrderGatePrereqs, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { entryFixture } from "./helpers/order-entry";
import { POST } from "@/app/api/orders/preview/route";

const noParams = { params: Promise.resolve({}) };
const required = ["orders.create", "customers.view", "parts.view"];

function request(cookie: string | undefined, body: unknown): Request {
  return new Request("http://t/api/orders/preview", {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const bodyFor = (customerId: string, partId: string) => ({
  customerId,
  lines: [{ partId, qty: 30, weight: 3810 }],
});

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
});

describe("POST /api/orders/preview", () => {
  it("requires an authenticated session", async () => {
    const { customer, lead } = await entryFixture();
    const response = await POST(request(undefined, bodyFor(customer.id, lead.id)), noParams);
    expect(response.status).toBe(401);
  });

  it.each(required)("requires %s while granting every other required permission", async (missing) => {
    const { customer, lead } = await entryFixture();
    const cookie = await signInWith(
      [...required.filter((permission) => permission !== missing), "processes.view"],
      `missing-${missing.replace(".", "-")}`,
    );

    const response = await POST(request(cookie, bodyFor(customer.id, lead.id)), noParams);

    expect(response.status).toBe(403);
  });

  it("calculates loads without processes.view and omits process content", async () => {
    const { customer, lead } = await entryFixture();
    const limited = await signInWith(required, "preview-limited");
    const full = await signInWith([...required, "processes.view"], "preview-full");

    const limitedResponse = await POST(request(limited, bodyFor(customer.id, lead.id)), noParams);
    expect(limitedResponse.status).toBe(200);
    const limitedPreview = await limitedResponse.json();
    expect(limitedPreview.loads).toEqual([
      { loadNumber: 1, qty: 15, weight: 1905 },
      { loadNumber: 2, qty: 15, weight: 1905 },
    ]);
    expect(limitedPreview).not.toHaveProperty("process");

    const fullResponse = await POST(request(full, bodyFor(customer.id, lead.id)), noParams);
    expect(fullResponse.status).toBe(200);
    const fullPreview = await fullResponse.json();
    expect(fullPreview.process.steps).toHaveLength(3);
    expect(fullPreview.fingerprint).toBe(limitedPreview.fingerprint);
  });

  it("does not let request JSON enable process presentation", async () => {
    const { customer, lead } = await entryFixture();
    const cookie = await signInWith(required, "preview-no-escalation");
    const response = await POST(request(cookie, {
      ...bodyFor(customer.id, lead.id),
      includeProcess: true,
    }), noParams);

    expect(response.status).toBe(400);
  });

  it("rejects a deleted lead", async () => {
    const { customer, lead } = await entryFixture();
    await prisma.part.update({ where: { id: lead.id }, data: { deletedAt: new Date() } });
    const cookie = await signInWith([...required, "processes.view"], "preview-deleted-lead");

    const response = await POST(request(cookie, bodyFor(customer.id, lead.id)), noParams);

    expect(response.status).toBe(400);
  });

  it("rejects an inactive lead", async () => {
    const { customer, lead } = await entryFixture();
    await prisma.part.update({ where: { id: lead.id }, data: { active: false } });
    const cookie = await signInWith([...required, "processes.view"], "preview-inactive-lead");

    const response = await POST(request(cookie, bodyFor(customer.id, lead.id)), noParams);

    expect(response.status).toBe(400);
  });

  it("rejects a lead owned by another customer", async () => {
    const { lead } = await entryFixture();
    const other = await prisma.customer.create({ data: { code: "OTHER", name: "Other Customer" } });
    const cookie = await signInWith([...required, "processes.view"], "preview-cross-customer");

    const response = await POST(request(cookie, bodyFor(other.id, lead.id)), noParams);

    expect(response.status).toBe(400);
  });

  it("rejects missing and inactive customers", async () => {
    const { customer, lead } = await entryFixture();
    const cookie = await signInWith([...required, "processes.view"], "preview-customer-eligibility");

    expect((await POST(request(cookie, bodyFor("missing", lead.id)), noParams)).status).toBe(400);
    await prisma.customer.update({ where: { id: customer.id }, data: { active: false } });
    expect((await POST(request(cookie, bodyFor(customer.id, lead.id)), noParams)).status).toBe(400);
  });

  it("rejects a step-less rider when it is submitted as the lead", async () => {
    const { customer, rider } = await entryFixture();
    const cookie = await signInWith([...required, "processes.view"], "preview-step-less-lead");

    const response = await POST(request(cookie, bodyFor(customer.id, rider.id)), noParams);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("This part has no process steps");
  });

  it("maps malformed payloads to 400", async () => {
    const { customer, lead } = await entryFixture();
    const cookie = await signInWith([...required, "processes.view"], "preview-malformed");
    const malformed = [
      null,
      [],
      { customerId: customer.id, lines: [] },
      { customerId: customer.id, lines: [{ partId: lead.id, qty: 0, weight: 3810 }] },
      { customerId: customer.id, lines: [{ partId: lead.id, qty: 30, weight: "junk" }] },
    ];

    for (const body of malformed) {
      const response = await POST(request(cookie, body), noParams);
      expect(response.status).toBe(400);
    }
  });
});
