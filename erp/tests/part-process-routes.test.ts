import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { appendProcessStep } from "@/server/process-document";
import { GET as revisionsGET } from "@/app/api/parts/[id]/process/revisions/route";
import { GET as revisionGET } from "@/app/api/parts/[id]/process/revisions/[n]/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** customer -> part -> a live step code — the fixture routes exercise below all target this
 *  part's process revisions. `part.create` needs `eachWeight: 1` (a required non-default column). */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  return { customer, part, code };
}

describe("process steps routes", () => {
  beforeEach(async () => await truncateAll());

  describe("GET /api/parts/[id]/process/revisions", () => {
    it("401s without a session", async () => {
      const { part } = await fixture();
      const res = await revisionsGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions`),
        { params: Promise.resolve({ id: part.id }) },
      );
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.view", async () => {
      const { part } = await fixture();
      const cookie = await signInWith(["parts.view"]);
      const res = await revisionsGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id }) },
      );
      expect(res.status).toBe(403);
    });

    it("200s with the revision summary list", async () => {
      const { part, code } = await fixture();
      await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "Heat to 1500F" }));

      const viewCookie = await signInWith(["processes.view"], "viewer");
      const res = await revisionsGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions`, { headers: { cookie: viewCookie } }),
        { params: Promise.resolve({ id: part.id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { revisionNumber: number; lockedAt: null; stepCount: number; createdAt: string }[];
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ revisionNumber: 1, lockedAt: null, stepCount: 1 });
      expect(body[0].createdAt).toEqual(expect.any(String));
    });
  });

  describe("GET /api/parts/[id]/process/revisions/[n]", () => {
    it("401s without a session", async () => {
      const { part } = await fixture();
      const res = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/1`),
        { params: Promise.resolve({ id: part.id, n: "1" }) },
      );
      expect(res.status).toBe(401);
    });

    it("403s for a session lacking processes.view", async () => {
      const { part } = await fixture();
      const cookie = await signInWith(["parts.view"]);
      const res = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/1`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id, n: "1" }) },
      );
      expect(res.status).toBe(403);
    });

    it("200s the full revision detail, joined to the live code", async () => {
      const { part, code } = await fixture();
      const cookie = await signInWith(["processes.view"]);
      await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "Heat to 1500F" }));

      const res = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/1`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id, n: "1" }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { revisionNumber: number; steps: { code: string; codeName: string; instruction: string }[] };
      expect(body.revisionNumber).toBe(1);
      expect(body.steps).toHaveLength(1);
      expect(body.steps[0]).toMatchObject({ code: "HT-01", codeName: "Austenitize", instruction: "Heat to 1500F" });
    });

    it("400s a non-numeric revision number instead of 500ing", async () => {
      const { part } = await fixture();
      const cookie = await signInWith(["processes.view"]);
      const res = await revisionGET(
        new Request(`http://t/api/parts/${part.id}/process/revisions/abc`, { headers: { cookie } }),
        { params: Promise.resolve({ id: part.id, n: "abc" }) },
      );
      expect(res.status).toBe(400);
    });
  });
});

describe("PATCH recipe-number", () => {
  beforeEach(async () => await truncateAll());
  it("authorizes, validates the baseline and returns the revision cut mapping", async () => {
    const { PATCH } = await import("@/app/api/parts/[id]/process/recipe-number/route");
    const { part, code } = await fixture();
    const editor = await signInWith(["processes.edit"], "recipe-editor");
    const viewer = await signInWith(["processes.view"], "recipe-viewer");
    const ctx = { params: Promise.resolve({ id: part.id }) };
    const request = (cookie: string, body: unknown) => PATCH(new Request(`http://t/api/parts/${part.id}/process/recipe-number`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    }), ctx);
    expect((await request(viewer, { recipeNumber: "001207", expectedRecipeNumber: null })).status).toBe(403);
    expect(await prisma.partRecipe.count()).toBe(0);
    expect((await request(editor, { recipeNumber: 1207 })).status).toBe(400);
    expect((await request(editor, { recipeNumber: "001207", expectedRecipeNumber: "stale" })).status).toBe(409);
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    await prisma.partProcessRevision.updateMany({ where: { partId: part.id }, data: { lockedAt: new Date() } });
    const success = await request(editor, { recipeNumber: "001207", expectedRecipeNumber: null });
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ recipeNumber: "001207", revisionNumber: 2, stepIdMap: { [stepId]: expect.any(String) } });
  });
});
