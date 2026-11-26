import { execFileSync } from "node:child_process";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { PRINT_NO_FOLDER, PRINT_WARNING_UNREADABLE } from "@/lib/customer-folder-words";
import {
  confirmText, JOIN_FAILED, joinedConfirmParts, joinedFileName, joinOrder, LOST_ANSWER, printTicksAfterRun,
  pruneToTickable, resultText, runSelectedPrints, ZIP_FAILED, zipFileName, zipPrints,
} from "@/lib/print-selected";

// #591 (owner rulings 591-4 to 591-8 and the words approved 2026-10-20): the Invoicing list's Print
// selected sends one print per ticked row in the list's order, shows each failure beside its row
// and carries on, stops after the request in flight once the page has gone, and hands back the
// prints for one zip. A lost answer is R13's (`unansweredStatus`): a 5xx, no response, or a 2xx
// whose bytes could not be read. The leaf is pure, so vitest's "node" environment reaches all of
// it, and each guard below is proven by changing it and watching its case go red.

const REFUSAL = "Invoice 1001 has already printed since it was finalized, so it was not printed again.";

const pdf = (id: string) => strToU8(`%PDF-1.7 ${id}`);
/** The print route's answer: the bytes, and the stored document's id in `x-document-id` (#1057). */
const printedAnswer = (id: string) =>
  new Response(pdf(id), { status: 200, headers: { "content-type": "application/pdf", "x-document-id": `doc-${id}` } });
/** One printed row as the run keeps it. */
const row = (id: string) => ({ id, bytes: pdf(id), documentId: `doc-${id}` });
const refusedAnswer = (status: number, body: unknown) => Response.json(body, { status });
/** The print route's `x-print-warnings` value (#588): a URI-encoded JSON array of one sentence. */
const encodedWarning = (sentence: string) => encodeURIComponent(JSON.stringify([sentence]));
const folderHeader = (sentence: string) => ({ "x-print-warnings": encodedWarning(sentence) });
/** A printed PDF whose answer carries `x-print-warnings` as `header`, given whole. */
const warnedAnswer = (id: string, header: string) =>
  new Response(pdf(id), { status: 200, headers: { "content-type": "application/pdf", "x-print-warnings": header } });

/** An answer per id (absent is a printed PDF), or the error its request rejects with. */
type Answers = Record<string, Response | Error>;

/** A run over `ids` whose `post` records each id it is sent, with the page always open. */
async function run(ids: string[], answers: Answers = {}) {
  const posted: string[] = [];
  const result = await runSelectedPrints(ids, async (id) => {
    posted.push(id);
    const answer = answers[id] ?? printedAnswer(id);
    if (answer instanceof Error) throw answer;
    return answer;
  }, () => true);
  return { posted, ...result };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Lets every pending promise reaction and timer run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("runSelectedPrints: the run", () => {
  it("sends one print at a time in the order given, and keeps each print's bytes with its id", async () => {
    const held = deferred<Response>();
    const posted: string[] = [];
    const running = runSelectedPrints(["c", "a", "b"], async (id) => {
      posted.push(id);
      return id === "c" ? held.promise : printedAnswer(id);
    }, () => true);
    await settle();
    expect(posted).toEqual(["c"]);
    held.resolve(printedAnswer("c"));
    const result = await running;
    expect(posted).toEqual(["c", "a", "b"]);
    expect(result.printed).toEqual([
      row("c"), row("a"), row("b"),
    ]);
    expect(result.failures).toEqual(new Map());
    expect(result.stopped).toBe(false);
  });

  it("carries on past a failure, which is that row's alone", async () => {
    const result = await run(["a", "b", "c"], { b: refusedAnswer(400, { error: REFUSAL }) });
    expect(result.posted).toEqual(["a", "b", "c"]);
    expect(result.printed.map((p) => p.id)).toEqual(["a", "c"]);
    expect(result.failures).toEqual(new Map([["b", REFUSAL]]));
  });
});

describe("runSelectedPrints: a failed print's sentence", () => {
  it("is the server's own sentence for a refusal (a 4xx carrying `error`)", async () => {
    const result = await run(["a"], { a: refusedAnswer(400, { error: REFUSAL }) });
    expect(result.failures).toEqual(new Map([["a", REFUSAL]]));
    expect(result.printed).toEqual([]);
  });

  it("is `Print failed (<status>)` for a 4xx with no `error`, or a body that is not JSON", async () => {
    const result = await run(["a", "b"], {
      a: refusedAnswer(403, {}),
      b: new Response("not json", { status: 404 }),
    });
    expect(result.failures).toEqual(new Map([["a", "Print failed (403)"], ["b", "Print failed (404)"]]));
  });

  it("is `Print failed (<status>)` when the 4xx's `error` is not a sentence", async () => {
    const result = await run(["a"], { a: refusedAnswer(400, { error: 123 }) });
    expect(result.failures).toEqual(new Map([["a", "Print failed (400)"]]));
  });

  it.each([500, 503])("is the lost-answer sentence for a %i, never the server's text: the print may have been stored", async (status) => {
    const result = await run(["a", "b"], {
      a: refusedAnswer(status, { error: "Internal server error" }),
      b: new Response(null, { status }),
    });
    expect(result.failures).toEqual(new Map([["a", LOST_ANSWER], ["b", LOST_ANSWER]]));
    expect(result.printed).toEqual([]);
  });

  it("is the lost-answer sentence when no answer arrived (the request rejected)", async () => {
    const result = await run(["a", "b"], { a: new TypeError("Failed to fetch") });
    expect(result.failures).toEqual(new Map([["a", LOST_ANSWER]]));
    expect(result.printed.map((p) => p.id)).toEqual(["b"]);
  });

  it("is the lost-answer sentence for a 2xx whose bytes could not be read, and keeps no print for it", async () => {
    const cut = new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } }), { status: 200 });
    const result = await run(["a", "b"], { a: cut });
    expect(result.failures).toEqual(new Map([["a", LOST_ANSWER]]));
    expect(result.printed.map((p) => p.id)).toEqual(["b"]);
  });
});

describe("runSelectedPrints: a printed row's folder sentence (#591 follow-up, the owner's ruling of 2026-10-21)", () => {
  // A row that printed but was not filed in its customer folder shows why beside it, as refusals
  // are shown: the single Print's own sentence, read from the same header by the same leaf.
  it("keeps the sentence of a print's x-print-warnings header under its id, and its bytes as printed", async () => {
    const result = await run(["a", "b"], { a: warnedAnswer("a", encodedWarning(PRINT_NO_FOLDER)) });
    expect(result.warnings).toEqual(new Map([["a", PRINT_NO_FOLDER]]));
    expect(result.printed).toEqual([{ ...row("a"), documentId: null }, row("b")]);
    expect(result.failures).toEqual(new Map());
  });

  it("keeps no entry for a print whose answer carries no header, or an empty array the invoice page draws no line for", async () => {
    const result = await run(["a", "b"], { b: warnedAnswer("b", encodeURIComponent("[]")) });
    expect(result.warnings).toEqual(new Map());
    expect(result.printed.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("reads a header that is not the route's shape as the unreadable-header sentence", async () => {
    // `%` alone is no URI encoding, and `{}` decodes but is not an array of sentences.
    const result = await run(["a", "b"], {
      a: warnedAnswer("a", "%"),
      b: warnedAnswer("b", encodeURIComponent("{}")),
    });
    expect(result.warnings).toEqual(new Map([["a", PRINT_WARNING_UNREADABLE], ["b", PRINT_WARNING_UNREADABLE]]));
    expect(result.printed.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("never gives a failure a folder sentence, whatever headers its answer carries", async () => {
    const cut = new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } }),
      { status: 200, headers: folderHeader(PRINT_NO_FOLDER) });
    const result = await run(["a", "b", "c"], {
      a: Response.json({ error: REFUSAL }, { status: 400, headers: folderHeader(PRINT_NO_FOLDER) }),
      b: Response.json({ error: "Internal server error" }, { status: 503, headers: folderHeader(PRINT_NO_FOLDER) }),
      c: cut,
    });
    expect(result.failures).toEqual(new Map([["a", REFUSAL], ["b", LOST_ANSWER], ["c", LOST_ANSWER]]));
    expect(result.warnings).toEqual(new Map());
    expect(result.printed).toEqual([]);
  });
});

describe("runSelectedPrints: leaving the page (591-6)", () => {
  it("sends nothing when the page has gone before the first request", async () => {
    const posted: string[] = [];
    const result = await runSelectedPrints(["a", "b"], async (id) => {
      posted.push(id);
      return printedAnswer(id);
    }, () => false);
    expect(posted).toEqual([]);
    expect(result).toEqual({ printed: [], failures: new Map(), warnings: new Map(), stopped: true });
  });

  it("stops after the request in flight when the page goes during it: exactly one request", async () => {
    const open = { current: true };
    const held = deferred<Response>();
    const posted: string[] = [];
    const running = runSelectedPrints(["a", "b", "c"], async (id) => {
      posted.push(id);
      return held.promise;
    }, () => open.current);
    await settle();
    open.current = false;
    held.resolve(printedAnswer("a"));
    const result = await running;
    expect(posted).toEqual(["a"]);
    expect(result.printed).toEqual([row("a")]);
    expect(result.stopped).toBe(true);
  });

  it("asks before every request and not after the last, so a finished run is not stopped", async () => {
    let asked = 0;
    const result = await runSelectedPrints(["a", "b", "c"], async (id) => printedAnswer(id), () => {
      asked += 1;
      return true;
    });
    expect(asked).toBe(3);
    expect(result.stopped).toBe(false);
  });
});

describe("zipPrints", () => {
  it("round-trips each entry's name and bytes, in the order given, stored uncompressed", () => {
    const entries = [
      { name: "Invoice-1002.pdf", bytes: pdf("1002") },
      { name: "Credit-1000.pdf", bytes: pdf("credit 1000") },
      { name: "Invoice-1001.pdf", bytes: pdf("1001") },
    ];
    const methods: number[] = [];
    const files = unzipSync(zipPrints(entries), {
      filter: (file) => {
        methods.push(file.compression);
        return true;
      },
    });
    expect(Object.keys(files)).toEqual(["Invoice-1002.pdf", "Credit-1000.pdf", "Invoice-1001.pdf"]);
    expect(strFromU8(files["Invoice-1002.pdf"])).toBe("%PDF-1.7 1002");
    expect(strFromU8(files["Credit-1000.pdf"])).toBe("%PDF-1.7 credit 1000");
    expect(strFromU8(files["Invoice-1001.pdf"])).toBe("%PDF-1.7 1001");
    // 0 is a zip's "stored": a PDF's streams are compressed already.
    expect(methods).toEqual([0, 0, 0]);
  });

  it("keeps a repeated name as -2, then -3, before the extension, rather than overwriting it", () => {
    const files = unzipSync(zipPrints([
      { name: "Invoice-1001.pdf", bytes: pdf("first") },
      { name: "Invoice-1001.pdf", bytes: pdf("second") },
      { name: "Credit-1000.pdf", bytes: pdf("credit") },
      { name: "Invoice-1001.pdf", bytes: pdf("third") },
    ]));
    expect(Object.keys(files)).toEqual(["Invoice-1001.pdf", "Invoice-1001-2.pdf", "Credit-1000.pdf", "Invoice-1001-3.pdf"]);
    expect(strFromU8(files["Invoice-1001.pdf"])).toBe("%PDF-1.7 first");
    expect(strFromU8(files["Invoice-1001-2.pdf"])).toBe("%PDF-1.7 second");
    expect(strFromU8(files["Invoice-1001-3.pdf"])).toBe("%PDF-1.7 third");
  });

  it("keeps a repeated name with no extension as -2 at its end", () => {
    const files = unzipSync(zipPrints([
      { name: "Invoice-1001", bytes: pdf("first") },
      { name: "Invoice-1001", bytes: pdf("second") },
    ]));
    expect(Object.keys(files)).toEqual(["Invoice-1001", "Invoice-1001-2"]);
    expect(strFromU8(files["Invoice-1001-2"])).toBe("%PDF-1.7 second");
  });
});

// A child process fixes TZ before the module loads (the format.test.ts precedent): changing
// process.env.TZ inside a shared Vitest worker would make this test affect unrelated tests. tsx
// loads the leaf and its extensionless imports. The child's 15-second bound sits inside the case's
// own 20 (the external-load-route.test.ts shape, which also starts tsx): vitest fails a case that
// overran its timeout once a synchronous call returns, so a child bound above the case's limit
// could never be the one that fires.
const LEAF = new URL("../src/lib/print-selected.ts", import.meta.url).href;
const zoneProbe = (iso: string) => `
  import { zipFileName } from ${JSON.stringify(LEAF)};
  process.stdout.write(zipFileName(new Date(${JSON.stringify(iso)})));
`;

describe("zipFileName", () => {
  it("is invoices-<YYYY-MM-DD>.zip, the month and day zero-padded", () => {
    expect(zipFileName(new Date(2026, 0, 5, 9, 30))).toBe("invoices-2026-01-05.zip");
  });

  it.each([
    // Behind UTC and ahead of it, each instant on a different UTC date from the zone's own; then
    // UTC itself, where the two agree.
    { zone: "America/Chicago", iso: "2026-03-04T03:30:00Z", name: "invoices-2026-03-03.zip" },
    { zone: "Pacific/Kiritimati", iso: "2026-03-03T12:00:00Z", name: "invoices-2026-03-04.zip" },
    { zone: "UTC", iso: "2026-03-03T23:59:00Z", name: "invoices-2026-03-03.zip" },
  ])("takes the browser's local date in $zone", ({ zone, iso, name }) => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", zoneProbe(iso)], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).toBe(name);
  }, 20_000);
});

describe("printTicksAfterRun", () => {
  it("keeps the failures and a tick added mid-run, and drops each row that printed", () => {
    // `x` was ticked during the run; `c` was unticked during it and printed.
    const prev = new Set(["a", "b", "x"]);
    const next = printTicksAfterRun(prev, new Set(["a", "b", "c"]), new Map([["b", REFUSAL]]), new Set(["a", "b", "c", "x"]));
    expect(next).toEqual(new Set(["b", "x"]));
    expect(prev).toEqual(new Set(["a", "b", "x"]));
  });

  it("never ticks a row that has no box: a failure or a kept tick outside `tickable` is dropped", () => {
    // The reload removed `b`'s box (another session printed it), and `y`'s before the run ended.
    const next = printTicksAfterRun(new Set(["a", "b", "y"]), new Set(["a", "b"]), new Map([["b", LOST_ANSWER]]), new Set(["a"]));
    expect(next).toEqual(new Set());
  });

  it("answers a new Set even when nothing changes", () => {
    const prev = new Set(["x"]);
    const next = printTicksAfterRun(prev, new Set(), new Map(), new Set(["x"]));
    expect(next).toEqual(prev);
    expect(next).not.toBe(prev);
  });
});

describe("pruneToTickable", () => {
  it("answers the same Set when every tick still has a box", () => {
    const prev = new Set(["a", "b"]);
    expect(pruneToTickable(prev, new Set(["a", "b", "c"]))).toBe(prev);
  });

  it("drops each tick whose row has no box, in a new Set", () => {
    const prev = new Set(["a", "b"]);
    const next = pruneToTickable(prev, new Set(["b"]));
    expect(next).toEqual(new Set(["b"]));
    expect(prev).toEqual(new Set(["a", "b"]));
  });
});

describe("the words (owner, 2026-10-20)", () => {
  it("confirms one document in the singular", () => {
    expect(confirmText(1)).toBe("Print 1 document? It is filed under its own Documents, and the PDF downloads as a zip file.");
  });

  it("confirms several documents in the plural", () => {
    expect(confirmText(12)).toBe("Print 12 documents? Each is filed under its own Documents, and the PDFs download as one zip file.");
    expect(confirmText(2)).toBe("Print 2 documents? Each is filed under its own Documents, and the PDFs download as one zip file.");
  });

  it("closes the run with the count printed of the count sent", () => {
    expect(resultText(11, 12)).toBe("Printed 11 of 12.");
    expect(resultText(1, 1)).toBe("Printed 1 of 1.");
  });

  it("says, after that line, when the zip could not be made (owner, 2026-10-21)", () => {
    expect(ZIP_FAILED).toBe("The zip could not be made; each print is under its own Documents.");
    expect(resultText(240, 240, true))
      .toBe("Printed 240 of 240. The zip could not be made; each print is under its own Documents.");
    expect(resultText(240, 240, false)).toBe("Printed 240 of 240.");
  });

  it("says when the joined PDF could not be made, for a run printed as one PDF (#1057)", () => {
    expect(JOIN_FAILED).toBe("The joined PDF could not be made; each print is under its own Documents.");
    expect(resultText(3, 4, true, "joined"))
      .toBe("Printed 3 of 4. The joined PDF could not be made; each print is under its own Documents.");
    expect(resultText(3, 4, true, "zip")).toBe(`Printed 3 of 4. ${ZIP_FAILED}`);
    expect(resultText(3, 4, false, "joined")).toBe("Printed 3 of 4.");
  });

  it("confirms Print as one PDF in the singular and the plural (#1057)", () => {
    expect(joinedConfirmParts(1)).toEqual({
      title: "Print 1 document as one PDF?", body: "It is filed under its own Documents, and it downloads as a PDF file.",
    });
    expect(joinedConfirmParts(3)).toEqual({
      title: "Print 3 documents as one PDF?", body: "Each is filed under its own Documents, and they download joined as one PDF file.",
    });
  });

  it("names the joined file as the zip is named, with a PDF's extension (#1057)", () => {
    const at = new Date(2026, 10, 6, 9, 30);
    expect(joinedFileName(at)).toBe("invoices-2026-11-06.pdf");
    expect(zipFileName(at)).toBe("invoices-2026-11-06.zip");
  });

  it("joins the printed rows' documents in the table's order, leaving out a row that did not print (#1057)", () => {
    const printed = [row("c"), row("a"), { ...row("b"), documentId: null }];
    expect(joinOrder([{ id: "a" }, { id: "x" }, { id: "b" }, { id: "c" }], printed)).toEqual(["doc-a", "doc-c"]);
  });

  it("states a lost answer", () => {
    expect(LOST_ANSWER).toBe("It may have printed, but the answer was lost. Reload to see.");
  });
});
