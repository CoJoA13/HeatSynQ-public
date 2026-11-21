import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = "1".repeat(64);
const reads = vi.hoisted(() => ({ initialized: 0, read: vi.fn() }));
vi.mock("@/server/external-loads", () => {
  reads.initialized++;
  return { readExternalLoad: reads.read };
});
const request = (auth = `Bearer ${token}`) => new Request("http://localhost/api/external/orders/1/loads/1", {
  headers: { authorization: auth },
});
const params = (orderNumber = "1", loadNumber = "1") => ({ params: Promise.resolve({ orderNumber, loadNumber }) });

beforeEach(() => { vi.resetModules(); reads.initialized = 0; reads.read.mockReset(); vi.stubEnv("LOADSYNQ_API_TOKEN", token); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("external load route", () => {
  it.each([undefined, "wrong"])("denies before importing the external reader (%s)", async (credential) => {
    if (credential === undefined) vi.stubEnv("LOADSYNQ_API_TOKEN", undefined);
    const { GET } = await import("@/app/api/external/orders/[orderNumber]/loads/[loadNumber]/route");
    expect(reads.initialized).toBe(0);
    const result = await GET(request(`Bearer ${credential ?? token}`), params());
    expect(result.status).toBe(credential === undefined ? 404 : 401);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(reads.initialized).toBe(0);
    expect(reads.read).not.toHaveBeenCalled();
  });

  it("keeps database initialization behind authorization in a fresh import process", async () => {
    // No Vitest bootstrap or module mock exists in this child. The authenticated positive
    // control must reach the database trap, proving denial did not merely miss the hook.
    const script = `
      const { registerHooks } = require('node:module');
      const assert = require('node:assert/strict');
      let initialized = 0;
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/src/server/db.ts')) { initialized++; throw new Error('DB_INIT_TRAP'); }
        return next(url, context);
      }});
      (async () => {
        const route = await import('./src/app/api/external/orders/[orderNumber]/loads/[loadNumber]/route.ts');
        const GET = route.GET ?? route.default.GET;
        const call = (auth) => GET(new Request('http://localhost/api/external/orders/1/loads/1',
          { headers: { authorization: auth } }), { params: Promise.resolve({ orderNumber: '1', loadNumber: '1' }) });
        delete process.env.LOADSYNQ_API_TOKEN;
        assert.equal((await call('Bearer ' + '1'.repeat(64))).status, 404);
        assert.equal(initialized, 0);
        process.env.LOADSYNQ_API_TOKEN = '1'.repeat(64);
        assert.equal((await call('Bearer wrong')).status, 401);
        assert.equal(initialized, 0);
        assert.equal((await call('Bearer ' + '1'.repeat(64))).status, 503);
        assert.ok(initialized > 0, 'authenticated control must reach DB trap');
      })().catch((error) => { process.stderr.write(String(error.stack ?? error).slice(0, 4000)); process.exitCode = 1; });
    `;
    const { stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: process.cwd(), timeout: 15000,
      env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" },
    });
    expect(stderr).toBe("");
  }, 20000);

  it.each(["0", "-1", "+1", "1.1", "1e2", "2147483648", "9007199254740993", "", " 1", "one"])("rejects non-Int path %s before importing the reader", async (value) => {
    const { GET } = await import("@/app/api/external/orders/[orderNumber]/loads/[loadNumber]/route");
    for (const context of [params(value), params("1", value)]) {
      const result = await GET(request(), context);
      expect(result.status).toBe(400);
      expect(result.headers.get("cache-control")).toBe("no-store");
    }
    expect(reads.initialized).toBe(0);
  });

  it("counts authenticated invalid paths toward the limit and emits Retry-After", async () => {
    const { GET } = await import("@/app/api/external/orders/[orderNumber]/loads/[loadNumber]/route");
    for (let i = 0; i < 60; i++) expect((await GET(request(), params("0"))).status).toBe(400);
    const result = await GET(request(), params());
    expect(result.status).toBe(429);
    expect(Number(result.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(reads.initialized).toBe(0);
  });

  it("accepts the Int ceiling and leading zeros, returning the reader contract", async () => {
    const { GET } = await import("@/app/api/external/orders/[orderNumber]/loads/[loadNumber]/route");
    reads.read.mockResolvedValue({ schemaVersion: 1, recipe: { status: "no_numbered_recipe", snapshot: null } });
    const result = await GET(request(), params("2147483647", "0001"));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(reads.read).toHaveBeenCalledWith(2147483647, 1);
    expect(await result.json()).toMatchObject({ schemaVersion: 1, recipe: { status: "no_numbered_recipe", snapshot: null } });
  });

  it.each([404, 503])("redacts reader failures with status %s", async (status) => {
    const { GET } = await import("@/app/api/external/orders/[orderNumber]/loads/[loadNumber]/route");
    const { HttpError } = await import("@/server/errors");
    reads.read.mockRejectedValue(status === 404 ? new HttpError(404, "private detail") : new Error("secret connection data"));
    const result = await GET(request(), params());
    expect(result.status).toBe(status);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ error: status === 404 ? "Not found" : "Service unavailable" });
  });
});
