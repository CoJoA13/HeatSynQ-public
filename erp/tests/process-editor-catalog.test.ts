import { beforeEach, describe, expect, it } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET } from "@/app/api/process/editor-catalog/route";

const ctx = { params: Promise.resolve({}) };

describe("GET /api/process/editor-catalog", () => {
  beforeEach(truncateAll);

  it("requires processes.view before disclosing standard instructions", async () => {
    await prisma.processStepCode.create({
      data: { code: "HT-01", name: "Austenitize", defaultInstruction: "Inspect packaging." },
    });

    const unauthenticated = await GET(new Request("http://t/api/process/editor-catalog"), ctx);
    expect(unauthenticated.status).toBe(401);

    const deniedCookie = await signInWith([], "denied-catalog");
    const denied = await GET(new Request("http://t/api/process/editor-catalog", {
      headers: { cookie: deniedCookie },
    }), ctx);
    expect(denied.status).toBe(403);
  });

  it("returns live active and inactive codes with defaults and sorted fields", async () => {
    const codeB = await prisma.processStepCode.create({
      data: { code: "HT-02", name: "Temper", active: false, defaultInstruction: "Temper slowly." },
    });
    const codeA = await prisma.processStepCode.create({
      data: { code: "HT-01", name: "Austenitize", defaultInstruction: "Inspect packaging." },
    });
    await prisma.processStepFieldDef.create({
      data: { codeId: codeA.id, label: "Time", type: "NUMBER", unit: "min", sort: 2 },
    });
    await prisma.processStepFieldDef.create({
      data: { codeId: codeA.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
    });
    await prisma.processStepCode.create({
      data: { code: "HT-03", name: "Deleted", deletedAt: new Date(), defaultInstruction: "Private deleted text" },
    });

    const cookie = await signInWith(["processes.view"], "catalog-viewer");
    const response = await GET(new Request("http://t/api/process/editor-catalog", {
      headers: { cookie },
    }), ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as Array<{
      id: string; code: string; name: string; active: boolean; defaultInstruction: string;
      fields: Array<{ label: string; type: string; unit: string | null; sort: number }>;
    }>;

    expect(body.map((code) => code.code)).toEqual(["HT-01", "HT-02"]);
    expect(body.find((code) => code.id === codeA.id)).toMatchObject({
      active: true, defaultInstruction: "Inspect packaging.",
      fields: [
        { label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
        { label: "Time", type: "NUMBER", unit: "min", sort: 2 },
      ],
    });
    expect(body.find((code) => code.id === codeB.id)).toMatchObject({
      active: false, defaultInstruction: "Temper slowly.", fields: [],
    });
  });

  it("returns 4000 instruction characters unchanged and refuses an invalid 4001-character row", async () => {
    const code = await prisma.processStepCode.create({
      data: { code: "HT-01", name: "Austenitize", defaultInstruction: "x".repeat(4000) },
    });
    const cookie = await signInWith(["processes.view"], "catalog-boundary-viewer");
    const request = () => new Request("http://t/api/process/editor-catalog", { headers: { cookie } });

    const accepted = await GET(request(), ctx);
    expect(accepted.status).toBe(200);
    expect((await accepted.json())[0].defaultInstruction).toBe("x".repeat(4000));

    await prisma.processStepCode.update({
      where: { id: code.id }, data: { defaultInstruction: "y".repeat(4001) },
    });
    const refused = await GET(request(), ctx);
    expect(refused.status).toBe(400);
  });
});
