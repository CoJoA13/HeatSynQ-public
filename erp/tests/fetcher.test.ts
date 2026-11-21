import { describe, it, expect, afterEach, vi } from "vitest";
import { api, ApiError, UnreadableAnswerError } from "@/lib/fetcher";

// Node's global fetch (undici), stubbed per test — no jsdom needed for this one, since `api()`
// only touches fetch/Response shapes, not the DOM.
describe("api() fetcher", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("resolves the parsed JSON body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ hello: "world" }),
    }));
    await expect(api("/x")).resolves.toEqual({ hello: "world" });
  });

  // ReferenceTable.remove() (src/components/ReferenceTable.tsx) needs to tell the delete guard's
  // 400 ("still in use by N records") apart from a 500 or a network failure, so it can fetch the
  // blocker list only for the former — reporting a genuine server error as "N records use it"
  // would misdiagnose what actually happened. That requires the status to survive the throw.
  it("throws an ApiError carrying the response status and the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: "That terms is still in use by 1 record(s)" }),
    }));
    await expect(api("/x")).rejects.toBeInstanceOf(ApiError);
    await expect(api("/x")).rejects.toMatchObject({
      message: "That terms is still in use by 1 record(s)", status: 400,
    });
  });

  it("falls back to a generic message when the failed response has no JSON error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => { throw new Error("not json"); },
    }));
    await expect(api("/x")).rejects.toMatchObject({ message: "Request failed (500)", status: 500 });
  });

  // The abort pass-through and the unreadable-answer error belong to an OK answer's body alone: a
  // failed response is an ApiError whatever its body and whatever the caller's signal says (#547).
  it("a failed response whose body cannot be read is still an ApiError while the caller's signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => { throw controller.signal.reason; },
    }));
    const error = await api("/x", { signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Request failed (500)", status: 500 });
  });
});

// #547 (owner ruling 2026-10-18): a 2xx whose body cannot be read is no answer, and `api()` says so
// by rejecting with an error that is not an ApiError and carries no `status`. Every body here is a
// real `Response`, made fresh for each call: a body read once cannot be read again, and that
// TypeError would itself be turned into the new error. The two sentences are the owner's, typed out
// in full so that changing a word fails this file.
describe("api() fetcher: an OK answer whose body cannot be read (#547)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const WRITE_SENTENCE = "The change was saved, but the answer could not be read. Reload the page to see it.";
  const READ_SENTENCE = "The answer could not be read. Reload the page to try again.";
  const encoder = new TextEncoder();
  /** Stubs `fetch` to answer 200 with a fresh body from `body()` on every call. */
  const answer = (body: () => BodyInit | null) => {
    const transport = vi.fn(async () => new Response(body(), { status: 200 }));
    vi.stubGlobal("fetch", transport);
    return transport;
  };
  /** A body that sends its first bytes and then hands its stream to `then`, which may fail it. */
  const startedBody = (first: string, then: (stream: ReadableStreamDefaultController) => void) => () =>
    new ReadableStream({ start(stream) { stream.enqueue(encoder.encode(first)); then(stream); } });

  it("an empty body to a write rejects with the write sentence: not an ApiError, no status, the read's SyntaxError as its cause", async () => {
    answer(() => "");
    const error = await api("/x", { method: "PATCH" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnreadableAnswerError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect("status" in (error as object)).toBe(false);
    expect((error as Error).message).toBe(WRITE_SENTENCE);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("a body cut short, to a read, rejects with the read sentence", async () => {
    answer(() => '{"order":');
    const error = await api("/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnreadableAnswerError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect("status" in (error as object)).toBe(false);
    expect((error as Error).message).toBe(READ_SENTENCE);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("a connection lost after the headers rejects with the write sentence and the stream's TypeError as its cause", async () => {
    answer(startedBody('{"id":', (stream) => stream.error(new TypeError("terminated"))));
    const error = await api("/x", { method: "DELETE" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnreadableAnswerError);
    expect((error as Error).message).toBe(WRITE_SENTENCE);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(((error as Error).cause as Error).message).toBe("terminated");
  });

  // The rule is "the read threw", never "the body is falsy" or "the body has a shape".
  it.each([
    ["null", null], ["false", false], ["0", 0], ["{}", {}],
  ] as const)("a readable %s is an answer", async (body, expected) => {
    answer(() => body);
    await expect(api("/x", { method: "PUT" })).resolves.toEqual(expected);
  });

  /** Calls `api()` with a signal its body follows, and aborts it one macrotask later: by then the
   *  stub's `fetch` has resolved and `api()` is reading the body, so the abort fails the body, not
   *  `fetch` (an abort there is fetch's own rejection, outside the body read). */
  async function abortAfterTheHeaders(abort: (controller: AbortController) => void) {
    const controller = new AbortController();
    const { signal } = controller;
    const transport = answer(startedBody('{"a":', (stream) => {
      signal.addEventListener("abort", () => stream.error(signal.reason));
    }));
    const running = api("/x", { method: "PATCH", signal }).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(transport.mock.results[0]!.value).resolves.toBeInstanceOf(Response);
    abort(controller);
    return { error: await running, reason: signal.reason as unknown };
  }

  it("the caller's own abort after the headers passes through unchanged", async () => {
    const { error, reason } = await abortAfterTheHeaders((controller) => controller.abort());
    expect(error).toBe(reason);
    expect((error as Error).name).toBe("AbortError");
  });

  it("the caller's own abort with its own reason passes through unchanged", async () => {
    const left = new Error("left");
    const { error } = await abortAfterTheHeaders((controller) => controller.abort(left));
    expect(error).toBe(left);
    expect(error).not.toBeInstanceOf(UnreadableAnswerError);
  });

  it("an AbortError the caller did not cause is the new error", async () => {
    answer(startedBody('{"a":', (stream) => stream.error(new DOMException("The operation was aborted.", "AbortError"))));
    const error = await api("/x", { method: "POST" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnreadableAnswerError);
    expect((error as Error).message).toBe(WRITE_SENTENCE);
    expect(((error as Error).cause as Error).name).toBe("AbortError");
  });

  it("a signal the caller passed and did not abort changes nothing", async () => {
    answer(() => "");
    const error = await api("/x", { method: "POST", signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnreadableAnswerError);
    expect((error as Error).message).toBe(WRITE_SENTENCE);
  });
});
