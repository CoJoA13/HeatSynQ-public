import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/operations/route";

const reads = vi.hoisted(() => ({ read: vi.fn(), initialized: 0 }));
vi.mock("@/server/operations-health", () => { reads.initialized++; return { readOperationsHealth: reads.read }; });
const token = "1".repeat(64);
const request = (auth?: string, suffix = "") => new Request(`http://localhost/api/health/operations${suffix}`, {
  headers: auth ? { Authorization: auth } : {},
});

beforeEach(() => { vi.stubEnv("HEALTH_MONITOR_TOKEN", token); reads.read.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("operations health authorization", () => {
  it("leaves operational modules uninitialized through rejected requests", async () => {
    expect(reads.initialized).toBe(0);
    expect((await GET(request())).status).toBe(401);
    expect(reads.initialized).toBe(0);
  });
  it.each(["", "short", "contains spaces even though this is sufficiently long"])("disables invalid token configuration: %s", async (value) => {
    vi.stubEnv("HEALTH_MONITOR_TOKEN", value);
    const res = await GET(request(`Bearer ${value}`));
    expect(res.status).toBe(404);
    expect(reads.read).not.toHaveBeenCalled();
  });
  it.each([undefined, "Basic " + token, "Bearer " + "2".repeat(64), "Bearer short"])("rejects unauthorized reads: %s", async (auth) => {
    const res = await GET(request(auth));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(reads.read).not.toHaveBeenCalled();
  });
  it("does not accept a query-string credential", async () => {
    expect((await GET(request(undefined, `?token=${token}`))).status).toBe(401);
    expect(reads.read).not.toHaveBeenCalled();
  });
  it("does not grant access to an administrator session cookie", async () => {
    const req = request(); req.headers.set("cookie", "erp_session=some-session");
    expect((await GET(req)).status).toBe(401);
    expect(reads.read).not.toHaveBeenCalled();
  });
  it("reports a healthy snapshot without caching or exposing internal detail", async () => {
    reads.read.mockResolvedValue({ ok: true, db: true, backups: "ok" });
    const res = await GET(request(`Bearer ${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, db: true, backups: "ok" });
  });
  it.each(["failed", "stale", "unknown"])("returns 503 for a %s backup", async (backups) => {
    reads.read.mockResolvedValue({ ok: false, db: true, backups });
    const res = await GET(request(`Bearer ${token}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: true, backups });
  });
  it("redacts unexpected operational errors", async () => {
    reads.read.mockRejectedValue(new Error("secret password and /private/backup.sql.gz"));
    const res = await GET(request(`Bearer ${token}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false, backups: "unknown" });
  });
});
