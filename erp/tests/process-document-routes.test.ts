import { beforeEach, describe, expect, it } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET, PUT } from "@/app/api/parts/[id]/process/document/route";
describe("process document routes", () => {
  beforeEach(truncateAll);
  it("requires separate read/edit permission and returns no-store authoritative documents", async () => {
    const customer = await prisma.customer.create({ data: { code: "C", name: "Customer" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P", eachWeight: 1 } });
    const params = { params: Promise.resolve({ id: part.id }) };
    expect((await GET(new Request("http://t"), params)).status).toBe(401);
    const cookie = await signInWith(["processes.view"]);
    const response = await GET(new Request("http://t", { headers: { cookie } }), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const baseline = await response.json();
    const body = JSON.stringify({ expectedBaselineToken: baseline.baselineToken, steps: [] });
    expect((await PUT(new Request("http://t", { method: "PUT", headers: { cookie }, body }), params)).status).toBe(403);
    const editor = await signInWith(["processes.view", "processes.edit"], "editor");
    const saved = await PUT(new Request("http://t", { method: "PUT", headers: { cookie: editor }, body }), params);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const oversized = await PUT(new Request("http://t", { method: "PUT", headers: { cookie: editor }, body: " ".repeat(1024 * 1024 + 1) }), params);
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).toContain("1 MiB");
  });

  it("refuses a retained-token no-op after view permission is revoked without disclosing updated defaults or mutating business data", async () => {
    const customer = await prisma.customer.create({ data: { code: "C", name: "Customer" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P", eachWeight: 1 } });
    const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat", defaultInstruction: "Original default" } });
    const cookie = await signInWith(["processes.view", "processes.edit"], "editor");
    const params = { params: Promise.resolve({ id: part.id }) };
    const read = await GET(new Request("http://t", { headers: { cookie } }), params);
    expect(read.status).toBe(200);
    const initial = await read.json();
    const created = await PUT(new Request("http://t", {
      method: "PUT", headers: { cookie }, body: JSON.stringify({
        expectedBaselineToken: initial.baselineToken,
        steps: [{ clientId: `new:${crypto.randomUUID()}`, stepId: null, codeId: code.id, codeSeen: { code: "HT", name: "Heat" }, instruction: "Part-owned instruction", parameters: [] }],
      }),
    }), params);
    expect(created.status).toBe(200);
    const { baseline } = await created.json();
    const step = baseline.revision.steps[0];
    const body = JSON.stringify({
      expectedBaselineToken: baseline.baselineToken,
      steps: [{ clientId: step.id, stepId: step.id, codeId: code.id, instruction: "Part-owned instruction", parameters: [] }],
    });
    await prisma.processStepCode.update({ where: { id: code.id }, data: { defaultInstruction: "New restricted instruction" } });
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "editor" } });
    await prisma.rolePermission.deleteMany({ where: { roleId: user.roleId!, permission: "processes.view" } });
    expect(await prisma.rolePermission.count({ where: { roleId: user.roleId!, permission: "processes.edit" } })).toBe(1);
    const snapshot = async () => ({
      part: await prisma.part.findUniqueOrThrow({ where: { id: part.id } }),
      revisions: await prisma.partProcessRevision.findMany({ where: { partId: part.id }, include: { steps: { include: { parameters: true } } } }),
      codes: await prisma.processStepCode.findMany(),
      audits: await prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
    });
    const before = await snapshot();
    // Reuse the original session and valid token; authorization must precede even body parsing.
    for (const submitted of [body, "not JSON"]) {
      const refused = await PUT(new Request("http://t", { method: "PUT", headers: { cookie }, body: submitted }), params);
      expect(refused.status).toBe(403);
      const response = await refused.text();
      expect(response).not.toContain("New restricted instruction");
      expect(response).not.toContain("defaultInstruction");
      expect(response).not.toContain("baseline");
      expect(await snapshot()).toEqual(before);
    }
  });
});
