import { describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import ts from "typescript";
import { PRINT_NO_FOLDER } from "@/lib/customer-folder-words";
import { invoiceFileName } from "@/lib/invoice-file-names";
import { printTickable, selectedPrintRefusal } from "@/lib/invoice-printed";
import {
  confirmParts, confirmText, JOIN_FAILED, joinedConfirmParts, joinedFileName, joinOrder, printTicksAfterRun, resultText,
  runSelectedPrints, ZIP_FAILED, zipFileName, zipPrints,
} from "@/lib/print-selected";
import { callback, runNode, source } from "./helpers/lift-callback";

// #591, owner rulings 591-4 to 591-8: the Invoicing list's Print selected. tests/print-selected.test.ts
// proves the run's rules on the leaf; this file proves the page is wired to them. vitest has no DOM,
// so the page's own `printSelected` is lifted out of its source (helpers/lift-callback, the
// invoicing-list-create-keys precedent) and run over the real leaves, with recording stand-ins for
// the confirm, the request, the download, the list's reload and the page's state. Each stand-in
// writes to one log, so a case can say what happened after what.
//
// The lifted function binds `printTicked` once, so the tick set is one live Set that `setPrintTicked`
// writes in place, as a render would hand the next click the state the last run left. It reads the
// ticked rows on screen from the render the click came from, `printRows`, which each case derives
// with the page's own initializer over its rows and ticks before the click. The page's
// `tickableRef` and mount ref `open` are objects the test hands it and changes: the reload stand-in
// writes `tickableRef.current` as the page's `loadInvoices` does when it applies a list, and a case
// that leaves the page flips `open.current` while a request is out.

const LIST = "app/invoicing/InvoicingList.tsx";

type Row = {
  id: string; kind: "INVOICE" | "CREDIT"; status: "DRAFT" | "FINALIZED"; printedAt: string | null;
  orderNumber: number; creditNumber: number | null; orderVoided: boolean;
};

/** The Invoices table as it stands, in its order: an invoice, a credit memo against the same order,
 *  and a second invoice, each finalized, not printed since and on a live order, so each draws a box. */
const ROWS: Row[] = [
  { id: "i1", kind: "INVOICE", status: "FINALIZED", printedAt: null, orderNumber: 1001, creditNumber: null, orderVoided: false },
  { id: "c1", kind: "CREDIT", status: "FINALIZED", printedAt: null, orderNumber: 1001, creditNumber: 1000, orderVoided: false },
  { id: "i2", kind: "INVOICE", status: "FINALIZED", printedAt: null, orderNumber: 1002, creditNumber: null, orderVoided: false },
];

/** The page's own `printRows` initializer, run over a case's rows and ticks: the ticked rows on
 *  screen as the render the click came from derived them. */
function printRowsOf(invoices: Row[], printTicked: Set<string>): Row[] {
  const file = source(LIST);
  let initializer: ts.Expression | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "printRows") {
      initializer = node.initializer;
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  if (!initializer) throw new Error("Missing production InvoicingList.printRows");
  return runNode<Row[]>(initializer, file, { invoices, printTicked, printTickable });
}

/** A print's bytes, different for each row, so an unzipped entry shows whose print it holds. */
const pdf = (id: string) => new TextEncoder().encode(`%PDF-1.7 ${id}`);
const printedAnswer = (id: string) =>
  new Response(pdf(id), { status: 200, headers: { "content-type": "application/pdf", "x-document-id": `doc-${id}` } });
/** The join's answer (#1057): one PDF, its bytes naming the documents it was asked for. */
const joinedAnswer = (init: RequestInit) => {
  const { documentIds } = JSON.parse(init.body as string) as { documentIds: string[] };
  return new Response(new TextEncoder().encode(`%PDF-1.7 joined ${documentIds.join(",")}`), {
    status: 200, headers: { "content-type": "application/pdf" },
  });
};
/** A row's print whose answer says it was not filed, the print route's `x-print-warnings` (#588). */
const unfiledAnswer = (id: string, sentence: string) => new Response(pdf(id), {
  status: 200,
  headers: { "content-type": "application/pdf", "x-print-warnings": encodeURIComponent(JSON.stringify([sentence])) },
});
const refusedAnswer = (sentence: string) =>
  new Response(JSON.stringify({ error: sentence }), { status: 400, headers: { "content-type": "application/json" } });

/** The server's already-printed refusal for a row, in the leaf's own words. */
const alreadyPrinted = (kind: Row["kind"], documentNumber: string) =>
  selectedPrintRefusal({ kind, documentNumber, status: "FINALIZED", printedAt: new Date() }) as string;

/** The page's Print selected, `ticks` ticked (default all three rows) and on screen with boxes. Each
 *  request answers with its row's print unless `answers` holds another for that id. `reload` is the
 *  tickable id set the post-run reload applies, or null when it fails and applies nothing. */
function page(
  ticks: string[] = ["i1", "c1", "i2"],
  options: { printing?: boolean; finalizing?: boolean; confirmed?: boolean; rows?: Row[] } = {},
) {
  const rows = options.rows ?? ROWS;
  const log: string[] = [];
  const answers: Record<string, () => Response> = {};
  const open = { current: true };
  // The tickable ids of the load that put these boxes on screen.
  const tickableRef = { current: new Set(rows.filter((r) => printTickable(r)).map((r) => r.id)) };
  const script: { reload: Set<string> | null } = { reload: new Set(tickableRef.current) };
  const loadInvoicesRef = {
    current: vi.fn(async () => {
      log.push("reload");
      if (script.reload) tickableRef.current = script.reload;
    }),
  };
  // Ruling 5 (PR 6): the page asks through the modal, the ruled sentence as the title and body.
  const confirm = vi.fn((text: string) => { log.push(`confirm ${text}`); return options.confirmed ?? true; });
  const askConfirm = vi.fn(async (q: { title: string; body: string; confirm: string }) => confirm(`${q.title} ${q.body}`));
  const trackedFetch = vi.fn(async (path: string, init: RequestInit) => {
    log.push(`${init.method} ${path}`);
    if (path === "/api/invoices/joined") return (joinAnswer.current ?? joinedAnswer)(init);
    const id = path.split("/")[3];
    return (answers[id] ?? (() => printedAnswer(id)))();
  });
  /** The join's answer when a case sets one; absent, the joined PDF. */
  const joinAnswer: { current: ((init: RequestInit) => Response) | null } = { current: null };
  const downloadFile = vi.fn((_bytes: Uint8Array, _name: string, _type?: string) => {
    void _bytes; void _name; void _type; log.push("download");
  });
  const printTicked = new Set(ticks);
  const setPrintTicked = vi.fn((next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    log.push("ticks");
    const value = typeof next === "function" ? next(new Set(printTicked)) : next;
    printTicked.clear();
    for (const id of value) printTicked.add(id);
  });
  const setPrinting = vi.fn((value: boolean) => { log.push(`printing ${value}`); });
  const setPrintErrors = vi.fn((_errors: Map<string, string>) => { void _errors; log.push("errors"); });
  const setPrintWarnings = vi.fn((_warnings: Map<string, string>) => { void _warnings; log.push("warnings"); });
  const setPrintResult = vi.fn((value: string | null) => { log.push(`result ${value}`); });
  const printSelected = callback<(output?: "zip" | "joined") => Promise<void>>(LIST, "InvoicingList", "printSelected", {
    printing: options.printing ?? false, finalizing: options.finalizing ?? false,
    printRows: printRowsOf(rows, printTicked), open, tickableRef, loadInvoicesRef,
    setPrinting, setPrintErrors, setPrintWarnings, setPrintResult, setPrintTicked,
    askConfirm, trackedFetch, downloadFile,
    runSelectedPrints, zipPrints, zipFileName, printTicksAfterRun, confirmParts, resultText, invoiceFileName,
    joinedConfirmParts, joinedFileName, joinOrder,
  });
  /** Each request the page sent, in order: its method and path. */
  const requests = () => trackedFetch.mock.calls.map(([path, init]) => `${init.method} ${path}`);
  /** The one zip the page handed to the browser: its file name and its entries, name → bytes. */
  const zip = () => {
    expect(downloadFile).toHaveBeenCalledTimes(1);
    const [bytes, name] = downloadFile.mock.calls[0];
    return { name, entries: unzipSync(bytes) };
  };
  return {
    log, answers, joinAnswer, open, tickableRef, script, printTicked, printSelected, requests, zip, trackedFetch,
    confirm, downloadFile, loadInvoicesRef, setPrinting, setPrintErrors, setPrintWarnings, setPrintResult, setPrintTicked,
  };
}

const print = (id: string) => `POST /api/invoices/${id}/print?selected=1`;

describe("Invoicing list: Print selected", () => {
  it("sends nothing when the confirm is cancelled", async () => {
    const p = page(["i1", "c1", "i2"], { confirmed: false });
    await p.printSelected();
    expect(p.confirm).toHaveBeenCalledTimes(1);
    expect(p.requests()).toEqual([]);
    expect(p.log).toEqual([`confirm ${confirmText(3)}`]);
  });

  it("names the count of ticked rows in the confirm, one and three", async () => {
    const one = page(["i2"]);
    await one.printSelected();
    expect(one.confirm).toHaveBeenCalledWith(confirmText(1));
    const three = page();
    await three.printSelected();
    expect(three.confirm).toHaveBeenCalledWith(confirmText(3));
  });

  it("sends one selected print per ticked row, in the table's order rather than the order they were ticked", async () => {
    const p = page(["i2", "i1"]);
    await p.printSelected();
    expect(p.requests()).toEqual([print("i1"), print("i2")]);
  });

  it("sends nothing for a ticked row the table draws no box for", async () => {
    // c1 has printed since its finalize, so the table draws it no box; its tick is not the run's.
    const rows = ROWS.map((r) => (r.id === "c1" ? { ...r, printedAt: "2026-10-20T15:00:00.000Z" } : r));
    const p = page(["i1", "c1", "i2"], { rows });
    await p.printSelected();
    expect(p.confirm).toHaveBeenCalledWith(confirmText(2));
    expect(p.requests()).toEqual([print("i1"), print("i2")]);
  });

  it("sends nothing for a ticked row on a voided order, which the table draws no box for", async () => {
    const rows = ROWS.map((r) => (r.id === "c1" ? { ...r, orderVoided: true } : r));
    const p = page(["i1", "c1", "i2"], { rows });
    await p.printSelected();
    expect(p.confirm).toHaveBeenCalledWith(confirmText(2));
    expect(p.requests()).toEqual([print("i1"), print("i2")]);
  });

  it("downloads one zip of the prints under their #588 names, then reads the list, then sets the ticks and the line", async () => {
    const p = page();
    const before = zipFileName(new Date());
    await p.printSelected();
    const after = zipFileName(new Date());
    const { name, entries } = p.zip();
    expect([before, after]).toContain(name);
    expect(Object.keys(entries)).toEqual(["Invoice-1001.pdf", "Credit-1000.pdf", "Invoice-1002.pdf"]);
    expect(entries["Invoice-1001.pdf"]).toEqual(pdf("i1"));
    expect(entries["Credit-1000.pdf"]).toEqual(pdf("c1"));
    expect(entries["Invoice-1002.pdf"]).toEqual(pdf("i2"));
    // §5.13: the list is read again before the ticks and the messages are set, so a printed row's
    // box is gone by the time the line says it printed.
    expect(p.log).toEqual([
      `confirm ${confirmText(3)}`, "printing true", "errors", "warnings", "result null",
      print("i1"), print("c1"), print("i2"),
      "download", "reload", "ticks", "errors", "warnings", `result ${resultText(3, 3)}`, "printing false",
    ]);
    expect(p.printTicked).toEqual(new Set());
  });

  it("shows a refusal beside its row, carries on, and leaves the refused print out of the zip", async () => {
    const p = page();
    const sentence = alreadyPrinted("CREDIT", "1000");
    p.answers.c1 = () => refusedAnswer(sentence);
    await p.printSelected();
    expect(p.requests()).toEqual([print("i1"), print("c1"), print("i2")]);
    expect(p.setPrintErrors).toHaveBeenLastCalledWith(new Map([["c1", sentence]]));
    expect(Object.keys(p.zip().entries)).toEqual(["Invoice-1001.pdf", "Invoice-1002.pdf"]);
    expect(p.printTicked).toEqual(new Set(["c1"]));
  });

  it("shows a printed row's folder sentence beside it, after the reload, and keeps its print in the zip", async () => {
    // The owner's ruling of 2026-10-21: a row that printed but was not filed in its customer folder
    // says why beside it, as refusals are shown, in the single Print's own sentence.
    const p = page();
    p.answers.c1 = () => unfiledAnswer("c1", PRINT_NO_FOLDER);
    await p.printSelected();
    expect(p.setPrintWarnings).toHaveBeenCalledTimes(2);
    expect(p.setPrintWarnings).toHaveBeenNthCalledWith(1, new Map());
    expect(p.setPrintWarnings).toHaveBeenLastCalledWith(new Map([["c1", PRINT_NO_FOLDER]]));
    expect(p.setPrintErrors).toHaveBeenLastCalledWith(new Map());
    // Set with the failures, after the list is read again (§5.13).
    expect(p.log.slice(p.log.indexOf("reload"))).toEqual(
      ["reload", "ticks", "errors", "warnings", `result ${resultText(3, 3)}`, "printing false"]);
    // It printed: in the zip, and unticked.
    expect(Object.keys(p.zip().entries)).toEqual(["Invoice-1001.pdf", "Credit-1000.pdf", "Invoice-1002.pdf"]);
    expect(p.printTicked).toEqual(new Set());
  });

  it("clears the last run's folder sentences when a run starts, before anything is sent", async () => {
    const p = page(["i1"]);
    await p.printSelected();
    expect(p.setPrintWarnings).toHaveBeenNthCalledWith(1, new Map());
    expect(p.log.indexOf("warnings")).toBeLessThan(p.log.indexOf(print("i1")));
  });

  it("downloads nothing when nothing printed, and still reads the list and says so", async () => {
    const p = page(["i1", "i2"]);
    p.answers.i1 = () => refusedAnswer(alreadyPrinted("INVOICE", "1001"));
    p.answers.i2 = () => refusedAnswer(alreadyPrinted("INVOICE", "1002"));
    await p.printSelected();
    expect(p.downloadFile).not.toHaveBeenCalled();
    expect(p.loadInvoicesRef.current).toHaveBeenCalledTimes(1);
    expect(p.setPrintResult).toHaveBeenLastCalledWith(resultText(0, 2));
  });

  it("counts what printed of the rows it sent in the line beside the button", async () => {
    const p = page(["i1", "i2"]);
    p.answers.i2 = () => refusedAnswer(alreadyPrinted("INVOICE", "1002"));
    await p.printSelected();
    expect(p.setPrintResult).toHaveBeenLastCalledWith("Printed 1 of 2.");
    expect(p.setPrinting).toHaveBeenLastCalledWith(false);
  });

  it("stops after the request in flight when the page goes, with no zip, no reload and no state after", async () => {
    const p = page();
    p.answers.i1 = () => {
      p.open.current = false;
      p.log.push("left");
      return printedAnswer("i1");
    };
    await p.printSelected();
    expect(p.requests()).toEqual([print("i1")]);
    expect(p.downloadFile).not.toHaveBeenCalled();
    expect(p.loadInvoicesRef.current).not.toHaveBeenCalled();
    expect(p.setPrintTicked).not.toHaveBeenCalled();
    // The four set before the run went out, and nothing after it.
    expect(p.setPrinting).toHaveBeenCalledTimes(1);
    expect(p.setPrintErrors).toHaveBeenCalledTimes(1);
    expect(p.setPrintWarnings).toHaveBeenCalledTimes(1);
    expect(p.setPrintResult).toHaveBeenCalledTimes(1);
    expect(p.log.slice(p.log.indexOf("left") + 1)).toEqual([]);
  });

  it("says so when the zip cannot be made, and still reads the list, sets the ticks and the failures and frees the button", async () => {
    // The owner, 2026-10-21: "Say so, carry on". The prints are filed; a run too large for the
    // browser's memory throws a RangeError while the zip is built or handed over.
    const p = page();
    p.downloadFile.mockImplementation(() => { throw new RangeError("Array buffer allocation failed"); });
    const sentence = alreadyPrinted("CREDIT", "1000");
    p.answers.c1 = () => refusedAnswer(sentence);
    await p.printSelected();
    expect(p.log).toEqual([
      `confirm ${confirmText(3)}`, "printing true", "errors", "warnings", "result null",
      print("i1"), print("c1"), print("i2"),
      "reload", "ticks", "errors", "warnings", `result ${resultText(2, 3)} ${ZIP_FAILED}`, "printing false",
    ]);
    expect(p.setPrintErrors).toHaveBeenLastCalledWith(new Map([["c1", sentence]]));
    expect(p.printTicked).toEqual(new Set(["c1"]));
  });

  it("frees the button when anything after the run throws while the page is open", async () => {
    // Nothing after the run is expected to throw (the reload catches its own failure); this is the
    // `finally`'s belt, so a throw there cannot leave the button at Printing… for good.
    const p = page();
    p.loadInvoicesRef.current.mockRejectedValueOnce(new Error("reload threw"));
    await expect(p.printSelected()).rejects.toThrow("reload threw");
    expect(p.setPrinting).toHaveBeenLastCalledWith(false);
    expect(p.setPrintResult).toHaveBeenLastCalledWith(null);
  });

  it("sends nothing on a second click while a run is out", async () => {
    const p = page(["i1"], { printing: true });
    await p.printSelected();
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.requests()).toEqual([]);
    expect(p.log).toEqual([]);
  });

  it("sends nothing while a Finalize selected run is out (#1057)", async () => {
    const p = page(["i1"], { finalizing: true });
    await p.printSelected();
    await p.printSelected("joined");
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.requests()).toEqual([]);
  });

  it("keeps a failed row ticked only while the list the reload put on screen still gives it a box", async () => {
    // i1 prints; c1 and i2 are refused as already printed (another session printed them), and the
    // reload shows c1 printed, so its box is gone, while i2 still has one.
    const p = page();
    p.answers.c1 = () => refusedAnswer(alreadyPrinted("CREDIT", "1000"));
    p.answers.i2 = () => refusedAnswer(alreadyPrinted("INVOICE", "1002"));
    p.script.reload = new Set(["i2"]);
    await p.printSelected();
    expect(p.printTicked).toEqual(new Set(["i2"]));
  });

  it("intersects with the last applied list when the reload applies nothing", async () => {
    // A filter change landed during the run and hid c1, so `loadInvoices` wrote the new list's
    // tickable ids; the post-run reload then failed and wrote none. c1 failed, but its row is not on
    // screen, so it is not ticked again.
    const p = page();
    p.answers.i1 = () => {
      p.tickableRef.current = new Set(["i2"]);
      return printedAnswer("i1");
    };
    p.answers.c1 = () => refusedAnswer(alreadyPrinted("CREDIT", "1000"));
    p.answers.i2 = () => refusedAnswer(alreadyPrinted("INVOICE", "1002"));
    p.script.reload = null;
    await p.printSelected();
    expect(p.printTicked).toEqual(new Set(["i2"]));
  });
});

// #1057 (owner rulings 2026-11-26 and the build answers of the same day): Print as one PDF is the same
// run, each print filed by its own selected print, then the stored prints joined by the server in the
// table's order and downloaded as one PDF in place of the zip.
describe("Invoicing list: Print as one PDF", () => {
  const joined = "POST /api/invoices/joined";

  it("asks in its own words and sends nothing when cancelled", async () => {
    const p = page(["i1", "c1", "i2"], { confirmed: false });
    await p.printSelected("joined");
    const q = joinedConfirmParts(3);
    expect(p.log).toEqual([`confirm ${q.title} ${q.body}`]);
    expect(p.requests()).toEqual([]);
  });

  it("prints each row, then joins the printed rows' documents in the table's order and downloads one PDF", async () => {
    const p = page(["i2", "i1", "c1"]);
    p.answers.c1 = () => refusedAnswer(alreadyPrinted("CREDIT", "1000"));
    const before = joinedFileName(new Date());
    await p.printSelected("joined");
    const after = joinedFileName(new Date());
    expect(p.requests()).toEqual([print("i1"), print("c1"), print("i2"), joined]);
    const joinCall = p.trackedFetch.mock.calls.find(([path]) => path === "/api/invoices/joined")!;
    expect(JSON.parse(joinCall[1].body as string)).toEqual({ documentIds: ["doc-i1", "doc-i2"] });
    expect(p.downloadFile).toHaveBeenCalledTimes(1);
    const [bytes, name, type] = p.downloadFile.mock.calls[0];
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.7 joined doc-i1,doc-i2");
    expect([before, after]).toContain(name);
    expect(type).toBe("application/pdf");
    expect(p.log.slice(-7)).toEqual(["download", "reload", "ticks", "errors", "warnings", `result ${resultText(2, 3)}`, "printing false"]);
    expect(p.setPrintResult).toHaveBeenLastCalledWith(resultText(2, 3));
    expect(p.printTicked).toEqual(new Set(["c1"]));
  });

  it("sends no join and downloads nothing when nothing printed", async () => {
    const p = page(["i1"]);
    p.answers.i1 = () => refusedAnswer(alreadyPrinted("INVOICE", "1001"));
    await p.printSelected("joined");
    expect(p.requests()).toEqual([print("i1")]);
    expect(p.downloadFile).not.toHaveBeenCalled();
    expect(p.setPrintResult).toHaveBeenLastCalledWith(resultText(0, 1));
  });

  it("says so when the join is refused or lost, and still reads the list and frees the button", async () => {
    for (const answer of [() => new Response("{}", { status: 400 }), () => { throw new Error("network"); }]) {
      const p = page(["i1"]);
      p.joinAnswer.current = answer;
      await p.printSelected("joined");
      expect(p.downloadFile).not.toHaveBeenCalled();
      expect(p.log).toContain("reload");
      expect(p.setPrintResult).toHaveBeenLastCalledWith(`${resultText(1, 1)} ${JOIN_FAILED}`);
      expect(p.setPrinting).toHaveBeenLastCalledWith(false);
    }
  });

  it("downloads nothing and sets no state when the page goes while the join is out", async () => {
    const p = page(["i1"]);
    p.joinAnswer.current = (init) => { p.open.current = false; return joinedAnswer(init); };
    await p.printSelected("joined");
    expect(p.downloadFile).not.toHaveBeenCalled();
    expect(p.log).not.toContain("reload");
    expect(p.setPrinting).toHaveBeenCalledTimes(1);
  });
});

describe("Invoicing list: the zip's download", () => {
  it("clicks an anchor attached to the document, takes it away again, and frees the object URL a minute later", () => {
    // An older browser downloads only from an anchor in the document. `downloadFile` is the page's
    // module-level function, run from its source over a stand-in document, URL and timer.
    const file = source(LIST);
    const declaration = file.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "downloadFile");
    if (!declaration) throw new Error("Missing production InvoicingList downloadFile");
    const log: string[] = [];
    const attached = new Set<object>();
    const anchor = {
      href: "", download: "",
      click() { log.push(attached.has(anchor) ? "click attached" : "click detached"); },
      remove() { attached.delete(anchor); log.push("remove"); },
    };
    const document = {
      createElement: (tag: string) => { log.push(`create ${tag}`); return anchor; },
      body: { appendChild: (node: object) => { attached.add(node); log.push("append"); return node; } },
    };
    const URL = {
      createObjectURL: (blob: Blob) => { log.push(`url ${blob.type} ${blob.size}`); return "blob:zip"; },
      revokeObjectURL: (url: string) => { log.push(`revoke ${url}`); },
    };
    const timers: { run: () => void; ms: number }[] = [];
    const setTimeout = (run: () => void, ms: number) => { timers.push({ run, ms }); };
    const downloadFile = runNode<(bytes: Uint8Array, name: string) => void>(
      declaration, file, { document, URL, Blob, setTimeout });

    downloadFile(new Uint8Array([1, 2, 3]), "invoices-2026-10-21.zip");
    expect(log).toEqual(["url application/zip 3", "create a", "append", "click attached", "remove"]);
    expect(anchor).toMatchObject({ href: "blob:zip", download: "invoices-2026-10-21.zip" });
    expect(attached.size).toBe(0);
    expect(timers.map((t) => t.ms)).toEqual([60_000]);
    timers[0].run();
    expect(log.at(-1)).toBe("revoke blob:zip");
  });
});
