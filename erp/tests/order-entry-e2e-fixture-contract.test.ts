import { expect, it, vi } from "vitest";
import { entryFixture } from "../e2e/lib/order-entry-workspace.mjs";

const response = (data: unknown) => ({ status: () => 200, text: async () => JSON.stringify(data), json: async () => data });
const DOCUMENT = "http://fixture.invalid/api/parts/created-part/process/document";
const CATALOG = "http://fixture.invalid/api/process/editor-catalog";
// A part with no process yet: the fixture's first step is appended to an empty document, with the
// code's suggested parameters copied onto it (keys = suggestion ids, empty values), as the editor's
// Add does — spec 2026-09-26 §3.2.
const emptyDocument = { revision: null, baselineToken: "fixture-token", codes: [] };
const catalog = [{ id: "owned-code", code: "E2E-QNCH", name: "E2E Quench", active: true, defaultInstruction: "",
  fields: [{ id: "sg-temperature", label: "Temperature", type: "NUMBER", unit: "°F", sort: 0 }, { id: "sg-passed", label: "Passed", type: "CHECKBOX", unit: null, sort: 1 }] }];
function fixture(readPart: Record<string, unknown>) {
  const page = { request: { get: vi.fn(async (url: string) => response(url === DOCUMENT ? emptyDocument : url === CATALOG ? catalog : readPart)) } };
  const ctx = { baseURL: "http://fixture.invalid", fixtures: { orderCustomerId: "owned-customer", orderCustomerCode: "OWNED", stepCodeA: { id: "owned-code" } },
    apiMutate: vi.fn(async (_page: unknown, url: string) => response(url === DOCUMENT ? { baseline: emptyDocument, stepIdMap: {}, parameterKeys: {} } : { id: "created-part" })) };
  return { page, ctx };
}

it("resolves the actual saved picker row after a part creation acknowledgement containing only id", async () => {
  const saved = { id: "created-part", customerId: "owned-customer", partNumber: "E2E-ENTRY-WORKSPACE", eachWeight: 127 };
  const { page, ctx } = fixture(saved);
  expect(await entryFixture(page, ctx, saved.partNumber)).toEqual(saved);
  expect(page.request.get).toHaveBeenCalledWith("http://fixture.invalid/api/parts/created-part", { maxRetries: 1 });
  expect(page.request.get).toHaveBeenCalledWith(DOCUMENT, { maxRetries: 1 });
  expect(page.request.get).toHaveBeenCalledWith(CATALOG, { maxRetries: 1 });
  expect(ctx.apiMutate).toHaveBeenCalledTimes(2);
  // The one save path (owner ruling 2026-09-26): the step is appended through the document save,
  // carrying its code's suggestions as rows.
  expect(ctx.apiMutate.mock.calls[1]).toEqual([page, DOCUMENT, {
    method: "PUT", data: { expectedBaselineToken: "fixture-token", steps: [{
      clientId: expect.stringMatching(/^new:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), stepId: null,
      codeId: "owned-code", codeSeen: { code: "E2E-QNCH", name: "E2E Quench" }, instruction: "Fictional E2E-ENTRY-WORKSPACE: verify this part's traveler settings.",
      parameters: [
        { key: "sg-temperature", label: "Temperature", type: "NUMBER", unit: "°F", value: "" },
        { key: "sg-passed", label: "Passed", type: "CHECKBOX", unit: null, value: "" },
      ],
    }] },
  }]);
});

it.each(["read", "catalog", "save"] as const)("stops the fixture when the process document %s does not answer 200", async failing => {
  const saved = { id: "created-part", customerId: "owned-customer", partNumber: "E2E-ENTRY-WORKSPACE", eachWeight: 127 };
  const { page, ctx } = fixture(saved);
  const refused = { status: () => 409, text: async () => "stale", json: async () => ({ error: "stale" }) };
  if (failing === "read") page.request.get.mockImplementation(async (url: string) => url === DOCUMENT ? refused : response(saved));
  else if (failing === "catalog") page.request.get.mockImplementation(async (url: string) => url === CATALOG ? refused : response(url === DOCUMENT ? emptyDocument : saved));
  else ctx.apiMutate.mockImplementation(async (_page: unknown, url: string) => url === DOCUMENT ? refused : response({ id: "created-part" }));
  await expect(entryFixture(page, ctx, saved.partNumber)).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  expect(ctx.apiMutate).toHaveBeenCalledTimes(failing === "save" ? 2 : 1);
});

it("refuses to append a step whose code the editor catalog does not list", async () => {
  const saved = { id: "created-part", customerId: "owned-customer", partNumber: "E2E-ENTRY-WORKSPACE", eachWeight: 127 };
  const { page, ctx } = fixture(saved);
  ctx.fixtures.stepCodeA.id = "unlisted-code";
  await expect(entryFixture(page, ctx, saved.partNumber)).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  expect(ctx.apiMutate).toHaveBeenCalledTimes(1);
});

it.each([
  { id: "wrong-part", customerId: "owned-customer", partNumber: "E2E-ENTRY-WORKSPACE" },
  { id: "created-part", customerId: "another-customer", partNumber: "E2E-ENTRY-WORKSPACE" },
  { id: "created-part", customerId: "owned-customer" },
])("refuses a mismatched saved fixture identity before adding process content", async saved => {
  const { page, ctx } = fixture(saved);
  await expect(entryFixture(page, ctx, "E2E-ENTRY-WORKSPACE")).rejects.toThrow();
  expect(ctx.apiMutate).toHaveBeenCalledTimes(1);
});
