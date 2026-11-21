import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = "1".repeat(64);
const request = (auth = `Bearer ${token}`, suffix = "") => new Request(`http://localhost/api/external/orders/1/loads/1${suffix}`, {
  headers: { authorization: auth },
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("LOADSYNQ_API_TOKEN", token);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("external recipe authorization", () => {
  it.each([undefined, "", "short", "g".repeat(64), "1".repeat(63)])("disables an unset or malformed credential (%s)", async (value) => {
    vi.stubEnv("LOADSYNQ_API_TOKEN", value);
    const { authorizeExternalRecipeRead: authorize } = await import("@/server/external-recipe-auth");
    expect(authorize(request())).toEqual({ ok: false, status: 404 });
  });

  it("rejects wrong bearer, health credential, session-only and query-only requests", async () => {
    vi.stubEnv("HEALTH_MONITOR_TOKEN", "2".repeat(64));
    const { authorizeExternalRecipeRead: authorize } = await import("@/server/external-recipe-auth");
    for (const auth of ["", `Bearer ${"2".repeat(64)}`, `Basic ${token}`, "Bearer short"]) {
      expect(authorize(request(auth))).toEqual({ ok: false, status: 401 });
    }
    const session = request(""); session.headers.set("cookie", "erp_session=admin-session");
    expect(authorize(session)).toEqual({ ok: false, status: 401 });
    expect(authorize(request("", `?token=${token}`))).toEqual({ ok: false, status: 401 });
  });

  it("allows 60 authenticated attempts, ceilings retry seconds, and resets at window expiry", async () => {
    const { authorizeExternalRecipeRead: authorize } = await import("@/server/external-recipe-auth");
    for (let i = 0; i < 60; i++) expect(authorize(request())).toEqual({ ok: true });
    expect(authorize(request())).toEqual({ ok: false, status: 429, retryAfter: 60 });
    vi.advanceTimersByTime(1001);
    expect(authorize(request())).toEqual({ ok: false, status: 429, retryAfter: 59 });
    vi.advanceTimersByTime(58999);
    expect(authorize(request())).toEqual({ ok: true });
  });

  it("starts a fresh window after rotation and does not spend allowance on arbitrary rejected strings", async () => {
    const { authorizeExternalRecipeRead: authorize } = await import("@/server/external-recipe-auth");
    for (let i = 0; i < 60; i++) expect(authorize(request())).toEqual({ ok: true });
    for (let i = 0; i < 500; i++) expect(authorize(request(`Bearer rejected-${i}`))).toEqual({ ok: false, status: 401 });
    expect(authorize(request())).toMatchObject({ status: 429 });
    const rotated = "a".repeat(64);
    vi.stubEnv("LOADSYNQ_API_TOKEN", rotated);
    for (let i = 0; i < 60; i++) expect(authorize(request(`Bearer ${rotated}`))).toEqual({ ok: true });
    expect(authorize(request(`Bearer ${rotated}`))).toMatchObject({ status: 429 });
  });
});
