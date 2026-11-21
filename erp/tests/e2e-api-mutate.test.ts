import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import { expect, it } from "vitest";
import { request, type APIRequestContext } from "playwright";
import { makeApiMutate } from "../e2e/api-mutate.mjs";
import { setRolePermissions } from "../e2e/lib/roles.mjs";

// #321: a keep-alive socket reset on a flow's state-restoring PUT left the shared restricted role
// narrowed, and three later flows failed on the role rather than on anything they test. These run
// the real Playwright APIRequestContext against a real server that destroys the first socket.
// Every write is preceded by one warming GET of /api/health, which the recorded paths include.

type OutOfBand = { committed: number; indeterminate: number };
type Page = { request: APIRequestContext };

async function withApi(handler: RequestListener, check: (page: Page, baseURL: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const api = await request.newContext();
  try {
    await check({ request: api }, `http://127.0.0.1:${address.port}`);
  } finally {
    await api.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function body(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

/** Resets the first request of `method`, then answers every request with `respond`. */
function resetFirst(method: string, seen: string[], respond: (req: IncomingMessage, text: string) => unknown): RequestListener {
  let reset = false;
  return async (req, res) => {
    const text = await body(req);
    seen.push(`${req.method} ${req.url}`);
    if (req.method === method && !reset) { reset = true; req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(respond(req, text)));
  };
}

it("an idempotent PUT recovers one reset socket and counts one committed write", async () => {
  const outOfBand: OutOfBand = { committed: 0, indeterminate: 0 };
  const seen: string[] = [];
  await withApi(resetFirst("PUT", seen, () => ({ ok: true })), async (page, baseURL) => {
    const res = await makeApiMutate(outOfBand)(page, `${baseURL}/api/admin/roles/r1`, {
      method: "PUT", data: { permissions: ["parts.view"] }, idempotent: true });
    expect(res.ok()).toBe(true);
  });
  expect(seen).toEqual(["GET /api/health", "PUT /api/admin/roles/r1", "PUT /api/admin/roles/r1"]);
  expect(outOfBand).toEqual({ committed: 1, indeterminate: 0 });
});

it("a write not marked idempotent is never replayed and stays indeterminate", async () => {
  for (const method of ["PUT", "POST"]) {
    const outOfBand: OutOfBand = { committed: 0, indeterminate: 0 };
    const seen: string[] = [];
    await withApi(resetFirst(method, seen, () => ({ ok: true })), async (page, baseURL) => {
      await expect(makeApiMutate(outOfBand)(page, `${baseURL}/api/x`, { method, data: {} })).rejects.toThrow(/ECONNRESET|socket hang up/);
    });
    expect(seen, method).toEqual(["GET /api/health", `${method} /api/x`]);
    expect(outOfBand, method).toEqual({ committed: 0, indeterminate: 1 });
  }
});

it("refuses a retry on a method that is not idempotent, before sending anything", async () => {
  for (const method of ["POST", "PATCH", "DELETE", undefined]) {
    const outOfBand: OutOfBand = { committed: 0, indeterminate: 0 };
    const seen: string[] = [];
    await withApi(resetFirst("none", seen, () => ({ ok: true })), async (page, baseURL) => {
      await expect(makeApiMutate(outOfBand)(page, `${baseURL}/api/x`, { method, data: {}, idempotent: true }))
        .rejects.toMatchObject({ code: "ERR_ASSERTION" });
      // A raw retry count would bypass the idempotency decision, whatever the method.
      await expect(makeApiMutate(outOfBand)(page, `${baseURL}/api/x`, { method: "PUT", data: {}, maxRetries: 1 }))
        .rejects.toMatchObject({ code: "ERR_ASSERTION" });
    });
    expect(seen, String(method)).toEqual([]);
    expect(outOfBand, String(method)).toEqual({ committed: 0, indeterminate: 0 });
  }
});

function rolesServer(seen: string[], stored: { permissions: string[] }, { resetPut = true, ignoreWrite = false } = {}) {
  return resetFirst(resetPut ? "PUT" : "none", seen, (req, text) => {
    if (req.method === "PUT") {
      if (!ignoreWrite) stored.permissions = (JSON.parse(text) as { permissions: string[] }).permissions;
      return { ok: true };
    }
    return [{ id: "other", permissions: [] }, { id: "r1", permissions: [...stored.permissions].sort() }];
  });
}

it("setRolePermissions survives a reset restore and verifies it by reading the role back", async () => {
  const outOfBand: OutOfBand = { committed: 0, indeterminate: 0 };
  const seen: string[] = [];
  const stored = { permissions: ["orders.view"] };
  await withApi(rolesServer(seen, stored), async (page, baseURL) => {
    await setRolePermissions(page, { baseURL, apiMutate: makeApiMutate(outOfBand) }, "r1",
      ["templates.view", "parts.view", "processes.view"]);
  });
  expect(stored.permissions).toEqual(["templates.view", "parts.view", "processes.view"]);
  expect(seen).toEqual(["GET /api/health", "PUT /api/admin/roles/r1", "PUT /api/admin/roles/r1", "GET /api/admin/roles"]);
});

it("setRolePermissions fails loudly when the read-back disagrees, instead of poisoning later flows", async () => {
  const outOfBand: OutOfBand = { committed: 0, indeterminate: 0 };
  const stored = { permissions: ["orders.view"] };
  await withApi(rolesServer([], stored, { resetPut: false, ignoreWrite: true }), async (page, baseURL) => {
    await expect(setRolePermissions(page, { baseURL, apiMutate: makeApiMutate(outOfBand) }, "r1", ["parts.view"]))
      .rejects.toMatchObject({ code: "ERR_ASSERTION" });
  });
});

/**
 * Emulates the measured race: the server drops a request arriving on a keep-alive socket that has
 * sat idle past `idleMs`, as Node does when a reuse meets its idle close. A fresh socket is served.
 */
function staleSocketServer(seen: string[], idleMs: number): RequestListener {
  const lastUse = new WeakMap<object, number>();
  return async (req, res) => {
    await body(req);
    const previous = lastUse.get(req.socket);
    seen.push(`${req.method} ${req.url}${previous !== undefined && Date.now() - previous > idleMs ? " (stale, reset)" : ""}`);
    if (previous !== undefined && Date.now() - previous > idleMs) { req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }), () => lastUse.set(req.socket, Date.now()));
  };
}

it("a non-idempotent write after an idle gap rides a freshly used socket, sent exactly once", async () => {
  const outOfBand: OutOfBand = { committed: 0, indeterminate: 0 };
  const seen: string[] = [];
  await withApi(staleSocketServer(seen, 100), async (page, baseURL) => {
    await page.request.get(`${baseURL}/api/earlier`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const res = await makeApiMutate(outOfBand)(page, `${baseURL}/api/orders`, { method: "POST", data: { qty: 1 } });
    expect(res.ok()).toBe(true);
  });
  // The idle socket takes the warming GET, which retries; the write follows on the fresh socket.
  expect(seen).toEqual(["GET /api/earlier", "GET /api/health (stale, reset)", "GET /api/health", "POST /api/orders"]);
  expect(outOfBand).toEqual({ committed: 1, indeterminate: 0 });
});

it("a warming failure sends no write and leaves the counters untouched", async () => {
  const outOfBand: OutOfBand = { committed: 0, indeterminate: 0 };
  const seen: string[] = [];
  await withApi((req) => { seen.push(`${req.method} ${req.url}`); req.socket.destroy(); }, async (page, baseURL) => {
    await expect(makeApiMutate(outOfBand)(page, `${baseURL}/api/orders`, { method: "POST", data: {} })).rejects.toThrow(/ECONNRESET|socket hang up/);
  });
  expect(seen).toEqual(["GET /api/health", "GET /api/health"]);
  expect(outOfBand).toEqual({ committed: 0, indeterminate: 0 });
});
