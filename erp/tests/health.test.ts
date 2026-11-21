import { describe, it, expect, vi } from "vitest";
import { prisma } from "@/server/db";
import { GET } from "@/app/api/health/route";

describe("health endpoint", () => {
  it("returns a safe 503 when the database rejects the readiness query", async () => {
    const query = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("private database connection"));
    try {
      const res = await GET();
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ ok: false, db: false });
    } finally { query.mockRestore(); }
  });
  it("reports ok and database connectivity", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, db: true });
  });
});
