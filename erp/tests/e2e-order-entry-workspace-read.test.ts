import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { it } from "vitest";
import { request, type APIRequestContext, type APIResponse } from "playwright";
import { mutate, readJson } from "../e2e/lib/order-entry-workspace.mjs";

type Page = { request: APIRequestContext };
type Context = {
  baseURL: string;
  apiMutate: (page: Page, url: string, options: NonNullable<Parameters<APIRequestContext["fetch"]>[1]>) => Promise<APIResponse>;
};

async function withApi(handler: RequestListener, check: (value: { page: Page; ctx: Context }) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const api = await request.newContext();
  try {
    await check({ page: { request: api }, ctx: { baseURL: `http://127.0.0.1:${address.port}`,
      apiMutate: (_page, url, options) => api.fetch(url, options) } });
  } finally {
    await api.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it("one reset read retries without replaying a committed mutation", async () => {
  let gets = 0;
  let posts = 0;
  await withApi((req, res) => {
    if (req.method === "POST") {
      posts++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"saved"}');
      return;
    }
    assert.equal(req.method, "GET");
    gets++;
    if (gets === 1) { req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"saved","loads":[1,2]}');
  }, async ({ page, ctx }) => {
    assert.deepEqual(await mutate(page, ctx, "/api/orders", { quantity: 2 }), { id: "saved" });
    assert.deepEqual(await readJson(page, ctx, "/api/orders/saved"), { id: "saved", loads: [1, 2] });
  });
  assert.equal(posts, 1);
  assert.equal(gets, 2);
});

it("a persistent reset stops after two GET attempts", async () => {
  let gets = 0;
  await withApi((req) => {
    assert.equal(req.method, "GET");
    gets++;
    req.socket.destroy();
  }, async ({ page, ctx }) => {
    await assert.rejects(readJson(page, ctx, "/api/orders/saved"));
  });
  assert.equal(gets, 2);
});

it("HTTP 500 is an assertion failure with one GET", async () => {
  let gets = 0;
  await withApi((_req, res) => {
    gets++;
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"broken"}');
  }, async ({ page, ctx }) => {
    await assert.rejects(readJson(page, ctx, "/api/orders/saved"), { code: "ERR_ASSERTION" });
  });
  assert.equal(gets, 1);
});

it("a bad successful response never retries JSON parsing", async () => {
  let gets = 0;
  await withApi((_req, res) => {
    gets++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("broken-json");
  }, async ({ page, ctx }) => {
    await assert.rejects(readJson(page, ctx, "/api/orders/saved"));
  });
  assert.equal(gets, 1);
});

it("a reset during a write does not replay the POST", async () => {
  let posts = 0;
  await withApi((req) => {
    assert.equal(req.method, "POST");
    posts++;
    req.socket.destroy();
  }, async ({ page, ctx }) => {
    await assert.rejects(mutate(page, ctx, "/api/orders", { quantity: 2 }));
  });
  assert.equal(posts, 1);
});
