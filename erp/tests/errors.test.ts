import { describe, it, expect } from "vitest";
import { HttpError } from "@/server/errors";
import { HttpError as ReExported, handle } from "@/server/http";

describe("HttpError", () => {
  it("carries status and message", () => {
    const err = new HttpError(404, "Not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err).toBeInstanceOf(Error);
  });

  it("is the same class when imported via http (re-export, not a copy)", () => {
    expect(ReExported).toBe(HttpError);
    expect(new ReExported(400, "x")).toBeInstanceOf(HttpError);
  });

  it("errors.ts imports nothing — the module graph stays acyclic", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/server/errors.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

// #655: `handle` maps a SyntaxError to 400 wherever it is thrown in a handler, not only at the
// `req.json()` parse (which the customers route test covers), so the map's breadth is stated:
// a service that threw one after the parse would answer 400 too. None does today.
describe("handle", () => {
  it("answers 400 with the body sentence for a SyntaxError thrown anywhere in the handler", async () => {
    const route = handle(async () => { throw new SyntaxError("Unexpected token"); });
    const res = await route(new Request("http://t/api/x"), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be valid UTF-8 JSON" });
  });

  it("still rethrows an error that is neither ZodError, HttpError nor SyntaxError", async () => {
    const route = handle(async () => { throw new TypeError("boom"); });
    await expect(route(new Request("http://t/api/x"), { params: Promise.resolve({}) })).rejects.toThrow("boom");
  });
});
