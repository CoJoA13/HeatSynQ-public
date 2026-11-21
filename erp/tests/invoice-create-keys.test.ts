import { describe, expect, it } from "vitest";
import { ApiError, UnreadableAnswerError, WRITE_ANSWER_UNREADABLE } from "@/lib/fetcher";
import { pruneCreateKeys, runInvoiceCreates, type CreateKeys } from "@/lib/invoice-create-keys";

// #568, owner ruling 2026-10-19 ("List only"): the Invoicing list sends each order's Create with a
// request key, made at its first Create in a run and kept until an answer lands. A 5xx, a dropped
// connection or an unreadable answer is no answer (R13 as #547 extended it), so the next run sends
// the same key and the server answers it as that request's own result. A success or a refusal is
// an answer, so the next run makes a fresh one. The leaf is pure, so vitest's "node" environment
// reaches all of it, and each guard below is proven by changing it and watching its case go red.

const SERVER_ERROR = (status = 500) => new ApiError("Internal server error", status);
const REFUSAL = "Order #1001 already has an invoice — discard its draft or credit the finalized one";

/** A run's outcome per order: an answer (`"ok"`) or the error its `post` throws. Absent is "ok". */
type Answers = Record<string, "ok" | Error>;

/** One list's keys across runs, a counting `mint` (`k1`, `k2`, …) and a recording `post`. Each
 *  run returns what it sent, in order, and its failures. */
function list() {
  const keys: CreateKeys = new Map();
  let minted = 0;
  const mint = () => `k${++minted}`;
  async function run(orderIds: string[], answers: Answers = {}) {
    const sent: Array<[string, string]> = [];
    const failures = await runInvoiceCreates(orderIds, keys, async (orderId, key) => {
      sent.push([orderId, key]);
      const answer = answers[orderId] ?? "ok";
      if (answer !== "ok") throw answer;
      return { invoice: { id: `invoice-${orderId}` }, warnings: [] };
    }, mint);
    return { sent, failures };
  }
  return { keys, run };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Lets every pending promise reaction and timer run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("runInvoiceCreates: a run's keys", () => {
  it("mints one key per order on a first run, distinct per order, and posts each with its order in turn", async () => {
    const l = list();
    const { sent, failures } = await l.run(["o1", "o2", "o3"]);
    expect(sent).toEqual([["o1", "k1"], ["o2", "k2"], ["o3", "k3"]]);
    expect(failures).toEqual(new Map());
  });

  it.each([500, 503])("re-sends the same key on the next run after an ApiError %i", async (status) => {
    const l = list();
    await l.run(["o1"], { o1: SERVER_ERROR(status) });
    expect(l.keys).toEqual(new Map([["o1", "k1"]]));
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k1"]]);
  });

  it("re-sends the same key on the next run after a dropped connection (a TypeError)", async () => {
    const l = list();
    await l.run(["o1"], { o1: new TypeError("Failed to fetch") });
    expect(l.keys).toEqual(new Map([["o1", "k1"]]));
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k1"]]);
  });

  it("re-sends the same key on the next run after an answer that could not be read", async () => {
    const l = list();
    await l.run(["o1"], { o1: new UnreadableAnswerError(WRITE_ANSWER_UNREADABLE, { cause: new SyntaxError("Unexpected end of JSON input") }) });
    expect(l.keys).toEqual(new Map([["o1", "k1"]]));
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k1"]]);
  });

  it("sends a fresh key on the next run after an ApiError 400", async () => {
    const l = list();
    await l.run(["o1"], { o1: new ApiError(REFUSAL, 400) });
    expect(l.keys).toEqual(new Map());
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k2"]]);
  });

  it("sends a fresh key on the next run after an ApiError 409", async () => {
    const l = list();
    await l.run(["o1"], { o1: new ApiError("Another change is in progress — try again", 409) });
    expect(l.keys).toEqual(new Map());
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k2"]]);
  });

  it("sends a fresh key on the next run after a success", async () => {
    const l = list();
    await l.run(["o1"]);
    expect(l.keys).toEqual(new Map());
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k2"]]);
  });

  it("keeps each order's key its own: a failure on one does not change another's", async () => {
    const l = list();
    await l.run(["o1", "o2"], { o1: SERVER_ERROR(), o2: SERVER_ERROR() });
    expect(l.keys).toEqual(new Map([["o1", "k1"], ["o2", "k2"]]));
    const second = await l.run(["o1", "o2"], { o1: new ApiError(REFUSAL, 400), o2: SERVER_ERROR() });
    expect(second.sent).toEqual([["o1", "k1"], ["o2", "k2"]]);
    expect(l.keys).toEqual(new Map([["o2", "k2"]]));
    expect((await l.run(["o1", "o2"])).sent).toEqual([["o1", "k3"], ["o2", "k2"]]);
  });

  it("keeps an order's key across a run that leaves the order out", async () => {
    const l = list();
    await l.run(["o1"], { o1: SERVER_ERROR() });
    expect((await l.run(["o2"])).sent).toEqual([["o2", "k2"]]);
    expect(l.keys).toEqual(new Map([["o1", "k1"]]));
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k1"]]);
  });
});

describe("runInvoiceCreates: a kept key that later gets an answer", () => {
  it("is dropped by a refusal of the re-sent key, so the run after mints a fresh one", async () => {
    const l = list();
    await l.run(["o1"], { o1: SERVER_ERROR() });
    expect((await l.run(["o1"], { o1: new ApiError(REFUSAL, 400) })).sent).toEqual([["o1", "k1"]]);
    expect(l.keys).toEqual(new Map());
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k2"]]);
  });

  it("is dropped by a success of the re-sent key, so the run after mints a fresh one", async () => {
    const l = list();
    await l.run(["o1"], { o1: SERVER_ERROR() });
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k1"]]);
    expect(l.keys).toEqual(new Map());
    expect((await l.run(["o1"])).sent).toEqual([["o1", "k2"]]);
  });
});

describe("runInvoiceCreates: the run", () => {
  it("goes on past a failure and reports each failed order's own message", async () => {
    const l = list();
    const { sent, failures } = await l.run(["o1", "o2", "o3"], {
      o1: new ApiError(REFUSAL, 400), o3: new TypeError("Failed to fetch"),
    });
    expect(sent.map(([orderId]) => orderId)).toEqual(["o1", "o2", "o3"]);
    expect(failures).toEqual(new Map([["o1", REFUSAL], ["o3", "Failed to fetch"]]));
  });

  it("posts one order at a time: the next order waits for the one before it, whose key is already kept", async () => {
    const keys: CreateKeys = new Map();
    const held = deferred<void>();
    const posted: string[] = [];
    let minted = 0;
    const running = runInvoiceCreates(["o1", "o2"], keys, async (orderId) => {
      posted.push(orderId);
      if (orderId === "o1") await held.promise;
    }, () => `k${++minted}`);
    await settle();
    expect(posted).toEqual(["o1"]);
    expect(keys.get("o1")).toBe("k1");
    held.resolve();
    expect(await running).toEqual(new Map());
    expect(posted).toEqual(["o1", "o2"]);
  });

  it("takes a mint that throws as that order's failure, keeps no key for it and goes on", async () => {
    const keys: CreateKeys = new Map();
    const sent: Array<[string, string]> = [];
    let calls = 0;
    const mint = () => {
      calls += 1;
      if (calls === 1) throw new Error("Cannot create a client ID");
      return `k${calls}`;
    };
    const post = async (orderId: string, key: string) => {
      sent.push([orderId, key]);
      throw SERVER_ERROR();
    };
    const failures = await runInvoiceCreates(["o1", "o2"], keys, post, mint);
    expect(failures).toEqual(new Map([["o1", "Cannot create a client ID"], ["o2", "Internal server error"]]));
    expect(sent).toEqual([["o2", "k2"]]);
    expect(keys).toEqual(new Map([["o2", "k2"]]));
  });
});

describe("pruneCreateKeys", () => {
  it("keeps every key when the candidates reload applied nothing (null)", () => {
    const keys: CreateKeys = new Map([["o1", "k1"], ["o2", "k2"]]);
    pruneCreateKeys(keys, null);
    expect(keys).toEqual(new Map([["o1", "k1"], ["o2", "k2"]]));
  });

  it("drops the key of each order the applied list no longer holds and keeps each one it holds", () => {
    const keys: CreateKeys = new Map([["o1", "k1"], ["o2", "k2"], ["o3", "k3"]]);
    pruneCreateKeys(keys, new Set(["o2", "o4"]));
    expect(keys).toEqual(new Map([["o2", "k2"]]));
  });
});
