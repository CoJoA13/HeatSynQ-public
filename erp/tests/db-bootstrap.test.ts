import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { bootstrapPublicDatabase, validateBootstrapUrl } from "../scripts/lib/public-bootstrap";

beforeEach(truncateAll);

describe("new-install bootstrap boundary", () => {
  it.each([
    "postgresql://erp:example@localhost/erp?schema=other",
    "postgresql://erp:example@localhost/erp?options=-csearch_path%3Dother",
    "postgresql://erp:example@localhost/erp?host=other",
    "postgresql://erp:example@localhost/erp?schema=public&schema=other",
    "file:./erp.db",
    "postgresql://localhost/erp",
  ])("refuses unsupported connection overrides without exposing credentials", (url) => {
    expect(() => validateBootstrapUrl(url)).toThrow(/db:bootstrap/);
    try { validateBootstrapUrl(url); } catch (error) { expect(String(error)).not.toContain("example"); }
  });

  it.each([
    "postgresql://erp:example@localhost/erp",
    "postgresql://erp:example@localhost/erp?schema=public",
    "postgresql://erp:example@localhost/erp?sslmode=require",
  ])("accepts a supported public-schema connection", (url) => {
    expect(() => validateBootstrapUrl(url)).not.toThrow();
  });

  it("makes the standard port explicit while preserving a configured port", () => {
    expect(new URL(validateBootstrapUrl("postgresql://erp:example@localhost/erp")).port).toBe("5432");
    expect(new URL(validateBootstrapUrl("postgresql://erp:example@localhost:15435/erp")).port).toBe("15435");
  });

  it("refuses an already migrated database even with no business rows, before invoking migrations", async () => {
    expect(await prisma.customer.count()).toBe(0);
    const before = await prisma.documentTemplate.findMany({ include: { versions: true }, orderBy: { id: "asc" } });
    const migrate = vi.fn(async () => undefined);
    await expect(bootstrapPublicDatabase(prisma, migrate)).rejects.toThrow("requires a completely empty database");
    expect(migrate).not.toHaveBeenCalled();
    expect(await prisma.documentTemplate.findMany({ include: { versions: true }, orderBy: { id: "asc" } })).toEqual(before);
  });
});
