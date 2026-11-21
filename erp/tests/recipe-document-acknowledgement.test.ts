import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { saveRecipeNumber } from "@/server/part-process-steps";
import * as documents from "@/server/process-document";
import { PATCH } from "@/app/api/parts/[id]/process/recipe-number/route";
beforeEach(truncateAll);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACK", name: "Acknowledgement fixture" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P", eachWeight: 1 } });
  await prisma.processStepCode.create({ data: { code: "PRIVATE", name: "Protected process", defaultInstruction: "Protected default instruction" } });
  return part;
}
const request = (id: string, cookie: string, recipeNumber: string, expectedRecipeNumber: string | null = null) => PATCH(new Request("http://t", { method: "PATCH", headers: { cookie }, body: JSON.stringify({ recipeNumber, expectedRecipeNumber }) }), { params: Promise.resolve({ id }) });
it("acknowledges the authoritative document for a process viewer and does not cache it", async () => {
  const part = await fixture(); const cookie = await signInWith(["processes.edit", "processes.view"]);
  const response = await request(part.id, cookie, "HELD-001");
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json(); expect(body.document).toBeDefined();
  expect(body.document.baseline).toEqual(await documents.readProcessDocument(part.id));
  expect(body.document.baseline.revision.recipeNumber).toBe("HELD-001");
  const repeat = await request(part.id, cookie, "HELD-001", "old-number");
  expect((await repeat.json()).document.baseline).toEqual(body.document.baseline);
});
it("keeps edit-only response compatibility without reading or exposing protected defaults", async () => {
  const part = await fixture(); const cookie = await signInWith(["processes.edit"]);
  const projection = vi.spyOn(documents, "readProcessDocumentProjection");
  const response = await request(part.id, cookie, "EDIT-ONLY");
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json(); expect(body).toEqual({ recipeNumber: "EDIT-ONLY", revisionNumber: 1, stepIdMap: {} });
  expect(projection).not.toHaveBeenCalled(); expect(JSON.stringify(body)).not.toContain("Protected default instruction");
});
it("rolls back the number mutation when its transaction-bound acknowledgement cannot be read", async () => {
  const part = await fixture();
  await expect(runWithContext({ actor: { id: null, name: "test" }, user: null }, () =>
    saveRecipeNumber(part.id, { recipeNumber: "ROLLBACK", expectedRecipeNumber: null }, async tx => {
      expect((await tx.partRecipe.findUniqueOrThrow({ where: { partId: part.id } })).number).toBe("ROLLBACK");
      throw new Error("Acknowledgement failed");
    }))).rejects.toThrow("Acknowledgement failed");
  expect(await prisma.partRecipe.count({ where: { partId: part.id } })).toBe(0);
  expect(await prisma.partProcessRevision.count({ where: { partId: part.id } })).toBe(0);
});
