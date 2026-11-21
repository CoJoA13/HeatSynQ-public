// #588: the customer's Invoice folder (the plan's T3). The save path checks a pasted folder through
// the office share before it is stored: a pass stores the normalised path, a refusal is a 400 with
// the owner's sentence and stores nothing, and a blank stores "" with no check. The check runs
// before the customer's transaction, in `createCustomer` after its duplicate-code read, in
// `updateCustomer` after its 404 read. The page's box sends the normalised text on blur, sends
// nothing when that equals what the box held at focus, and shows "Folder found." for a non-blank
// save that lands while it is still the box's newest, until the box's next save is sent or a reload
// stores another folder.
//
// A real temp directory stands in for the share, holding the marker and `Customers/Acme`; each test
// sets OFFICE_SHARE_DIR and OFFICE_SHARE_ROOT for the module's own check (it reads them per call)
// and puts them back after, deleting them when they were unset (tests/helpers/setup.ts unsets both).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { all, run } from "./helpers/source-lift";
import { callback } from "./helpers/lift-callback";
import { declared, jsxTags, renderedFrom } from "./helpers/jsx-source";
import { createCustomer, getCustomer, updateCustomer } from "@/server/customers";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";
import { rootDisplay } from "@/server/office-share-paths";
import { PUT as update } from "@/app/api/customers/[id]/route";
import { CUSTOMER_FOLDERS_MARKER, normalizeInvoiceFolder } from "@/lib/invoice-folder-entry";
import {
  BAD_PATH_NAME, FOLDER_NOT_FOUND, SAVE_NOT_CONNECTED, SHARE_ITSELF, SHARE_NOT_SET_UP, notInsideShare,
} from "@/lib/customer-folder-words";
import { makeLatestGate } from "@/lib/use-latest";
import { percentFromFraction } from "@/lib/rate-display";

const ROOT = "Z:\\";
const ACME = "Z:\\Customers\\Acme";
const PAGE = "app/customers/[id]/page.tsx";

let base: string;
let share: string;
// The module's check logs a refusal that touched the share to console.error: caught here, so the
// run stays quiet and a test can read the lines.
let logSpy: MockInstance<typeof console.error>;
const saved = { dir: process.env.OFFICE_SHARE_DIR, root: process.env.OFFICE_SHARE_ROOT };

function putBack(name: "OFFICE_SHARE_DIR" | "OFFICE_SHARE_ROOT", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A refusal: an HttpError 400 carrying exactly `sentence`. */
async function refusedWith(work: Promise<unknown>, sentence: string) {
  const error = await work.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ status: 400, message: sentence });
}

/** The `[customer-folders]` lines logged while `work` ran. `work` is awaited as it is, so an
 *  assertion inside it fails the test; a caller that means it to reject catches its own call. */
async function folderLogLines(work: () => Promise<unknown>): Promise<string[]> {
  const from = logSpy.mock.calls.length;
  await work();
  return logSpy.mock.calls.slice(from).map((call) => String(call[0])).filter((line) => line.startsWith("[customer-folders]"));
}

describe("the customer's Invoice folder, saved through the folder check", () => {
  beforeEach(async () => {
    await truncateAll();
    base = await mkdtemp(path.join(tmpdir(), "customer-invoice-folder-"));
    share = path.join(base, "share");
    await mkdir(path.join(share, "Customers", "Acme"), { recursive: true });
    await writeFile(path.join(share, CUSTOMER_FOLDERS_MARKER), "");
    process.env.OFFICE_SHARE_DIR = share;
    process.env.OFFICE_SHARE_ROOT = ROOT;
    logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    logSpy.mockRestore();
    putBack("OFFICE_SHARE_DIR", saved.dir);
    putBack("OFFICE_SHARE_ROOT", saved.root);
    await rm(base, { recursive: true, force: true });
  });

  it("a new customer holds a blank folder, and a create that sends none needs no share", async () => {
    delete process.env.OFFICE_SHARE_DIR;
    delete process.env.OFFICE_SHARE_ROOT;
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    expect((await getCustomer(id)).invoiceFolder).toBe("");
  });

  it("a pasted folder inside the share is stored normalised: the quotes, the slashes and a trailing slash go", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { invoiceFolder: '"Z:/Customers/Acme/"' });
    expect((await getCustomer(id)).invoiceFolder).toBe(ACME);
  });

  it("a blank is stored as blank with no check: no share is set up and the share's folder is gone", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { invoiceFolder: ACME });
    // With no share set up a non-blank paste is refused ("no share set up" below), and with the
    // share's folder gone it would be "not connected": a blank asks neither.
    delete process.env.OFFICE_SHARE_DIR;
    delete process.env.OFFICE_SHARE_ROOT;
    await updateCustomer(id, { invoiceFolder: "  " });
    expect((await getCustomer(id)).invoiceFolder).toBe("");
    process.env.OFFICE_SHARE_DIR = path.join(base, "no-such-share");
    process.env.OFFICE_SHARE_ROOT = ROOT;
    await updateCustomer(id, { invoiceFolder: "" });
    expect((await getCustomer(id)).invoiceFolder).toBe("");
  });

  describe("each refusal is a 400 with its sentence, and the stored folder and its History are unchanged", () => {
    const cases: [string, string, () => Promise<void> | void, () => string][] = [
      ["no share set up", ACME, () => { delete process.env.OFFICE_SHARE_DIR; delete process.env.OFFICE_SHARE_ROOT; }, () => SHARE_NOT_SET_UP],
      ["outside the share", "Y:\\Customers\\Acme", () => {}, () => notInsideShare(rootDisplay(ROOT))],
      ["the share itself", "Z:/", () => {}, () => SHARE_ITSELF],
      ["a name a share refuses", "Z:\\Customers\\Ac?me", () => {}, () => BAD_PATH_NAME],
      ["no folder at that path", "Z:\\Customers\\Beta", () => {}, () => FOLDER_NOT_FOUND],
      ["the marker missing", ACME, () => rm(path.join(share, CUSTOMER_FOLDERS_MARKER)), () => SAVE_NOT_CONNECTED],
    ];
    it.each(cases)("%s", async (_name, pasted, arrange, sentence) => {
      const { id } = await createCustomer({ code: "ACME", name: "Acme" });
      await mkdir(path.join(share, "Customers", "Other"));
      await updateCustomer(id, { invoiceFolder: "Z:\\Customers\\Other" });
      const entries = (await readAudit("customer", id)).length;
      await arrange();
      await refusedWith(updateCustomer(id, { invoiceFolder: pasted }), sentence());
      expect((await getCustomer(id)).invoiceFolder).toBe("Z:\\Customers\\Other");
      expect(await readAudit("customer", id)).toHaveLength(entries);
    });
  });

  it("History shows the folder's change", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    await updateCustomer(id, { invoiceFolder: "z:/Customers/Acme" });
    const [entry] = await readAudit("customer", id);
    expect(entry.action).toBe("update");
    expect((entry.before as { invoiceFolder: string }).invoiceFolder).toBe("");
    expect((entry.after as { invoiceFolder: string }).invoiceFolder).toBe("z:\\Customers\\Acme");
  });

  it("a create is checked the same way: a pass is stored normalised, a refusal creates nothing", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme", invoiceFolder: '"Z:/Customers/Acme"' });
    expect((await getCustomer(id)).invoiceFolder).toBe(ACME);
    await refusedWith(createCustomer({ code: "BETA", name: "Beta", invoiceFolder: "Z:\\Customers\\Beta" }), FOLDER_NOT_FOUND);
    expect(await prisma.customer.findFirst({ where: { code: "BETA" } })).toBeNull();
  });

  // The check runs after the reads that can refuse the save without the share: a refused folder
  // (one that would log a line) is not what answers, and the share is not asked.
  it("an unknown customer answers its 404, not the folder's refusal, and the share is not asked", async () => {
    const lines = await folderLogLines(async () => {
      await expect(updateCustomer("nope", { invoiceFolder: "Z:\\Customers\\Beta" }))
        .rejects.toMatchObject({ status: 404, message: "Customer not found" });
    });
    expect(lines).toEqual([]);
    // The same paste on a live customer is checked: refused, and its line logged.
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    const checked = await folderLogLines(() =>
      refusedWith(updateCustomer(id, { invoiceFolder: "Z:\\Customers\\Beta" }), FOLDER_NOT_FOUND));
    expect(checked).toHaveLength(1);
  });

  it("a duplicate code answers its own refusal, not the folder's, and the share is not asked", async () => {
    await createCustomer({ code: "ACME", name: "Acme" });
    const lines = await folderLogLines(async () => {
      await refusedWith(
        createCustomer({ code: "ACME", name: "Acme again", invoiceFolder: "Z:\\Customers\\Beta" }),
        "A customer with that code already exists",
      );
    });
    expect(lines).toEqual([]);
  });

  it("PUT /api/customers/[id] answers a refused folder 400 with its sentence, and a found one { ok: true }", async () => {
    const cookie = await signInWith(["customers.view", "customers.edit"], "folder-put");
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    const put = (invoiceFolder: string) => update(new Request(`http://t/api/customers/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ invoiceFolder }),
    }), { params: Promise.resolve({ id }) });
    const refused = await put("Z:\\Customers\\Beta");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: FOLDER_NOT_FOUND });
    const found = await put("Z:/Customers/Acme");
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ ok: true });
    expect((await getCustomer(id)).invoiceFolder).toBe(ACME);
  });
});

describe("the folder check runs before the customer's transaction", () => {
  // A check can wait up to 10 seconds on the share, so it must never sit inside a transaction.
  // Parsed, so a comment that names either call cannot satisfy it.
  const file = fileURLToPath(new URL("../src/server/customers.ts", import.meta.url));
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const starts = (fn: ts.FunctionDeclaration, callee: (text: string) => boolean) =>
    all(fn, ts.isCallExpression).filter((call) => callee(call.expression.getText(source))).map((call) => call.getStart(source));

  it.each(["createCustomer", "updateCustomer"])("%s calls checkCustomerFolder once, ahead of every withDbErrors and $transaction", (name) => {
    const fn = all(source, ts.isFunctionDeclaration).find((f) => f.name?.text === name);
    expect(fn, name).toBeDefined();
    const checks = starts(fn!, (text) => text === "checkCustomerFolder");
    const writes = starts(fn!, (text) => text === "withDbErrors" || text.endsWith(".$transaction"));
    expect(checks).toHaveLength(1);
    expect(writes.length).toBeGreaterThan(0);
    expect(checks[0]).toBeLessThan(Math.min(...writes));
  });
});

describe("the customer page's Invoice folder box", () => {
  type Commit = (v: string, atFocus: string) => void;
  /** Runs the page's own commit over a `save` whose answers the test settles, one per call. */
  function box() {
    const answers: ((saved: boolean) => void)[] = [];
    const save = vi.fn(() => new Promise<boolean>((resolve) => { answers.push(resolve); }));
    const patchDraft = vi.fn();
    const setFolderFoundFor = vi.fn();
    const folderNotice = makeLatestGate();
    const commit = callback<Commit>(PAGE, "CustomerDetail", "commitInvoiceFolder", {
      save, patchDraft, setFolderFoundFor, folderNotice, normalizeInvoiceFolder,
    });
    return { commit, save, patchDraft, setFolderFoundFor, answers };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("a text that normalises to what the box held at focus takes the normalised text and sends nothing", async () => {
    const b = box();
    b.commit(' "Z:/Customers/Acme\\" ', ACME);
    await settle();
    expect(b.save).not.toHaveBeenCalled();
    expect(b.patchDraft.mock.calls).toEqual([[{ invoiceFolder: ACME }]]);
    expect(b.setFolderFoundFor).not.toHaveBeenCalled();
  });

  // A belt: every folder the server stores is normalised, so the box is never given anything else
  // today. The compare reads both sides normalised all the same.
  it("what the box held at focus is compared normalised too", async () => {
    const b = box();
    b.commit(ACME, '"Z:/Customers/Acme/"');
    await settle();
    expect(b.save).not.toHaveBeenCalled();
    expect(b.patchDraft.mock.calls).toEqual([[{ invoiceFolder: ACME }]]);
  });

  it("a changed text sends the normalised value, clears the notice as it sends, and shows it when the save lands", async () => {
    const b = box();
    b.commit('"z:/Customers/Beta/"', ACME);
    expect(b.save.mock.calls).toEqual([[{ invoiceFolder: "z:\\Customers\\Beta" }]]);
    expect(b.setFolderFoundFor.mock.calls).toEqual([[null]]);
    b.answers[0](true);
    await settle();
    expect(b.setFolderFoundFor.mock.calls).toEqual([[null], ["z:\\Customers\\Beta"]]);
    expect(b.patchDraft).not.toHaveBeenCalled();
  });

  it("a refused save shows no notice", async () => {
    const b = box();
    b.commit("Z:\\Customers\\Beta", ACME);
    b.answers[0](false);
    await settle();
    expect(b.setFolderFoundFor.mock.calls).toEqual([[null]]);
  });

  it("a save that lands after a newer one was sent shows nothing; the newer one shows the notice", async () => {
    const b = box();
    b.commit("Z:\\Customers\\Beta", ACME);
    b.commit("Z:\\Customers\\Gamma", "Z:\\Customers\\Beta");
    b.answers[0](true);
    await settle();
    expect(b.setFolderFoundFor.mock.calls).toEqual([[null], [null]]);
    b.answers[1](true);
    await settle();
    expect(b.setFolderFoundFor.mock.calls).toEqual([[null], [null], ["Z:\\Customers\\Gamma"]]);
  });

  it("a blank that lands files nothing and shows no notice", async () => {
    const b = box();
    b.commit("  ", ACME);
    expect(b.save.mock.calls).toEqual([[{ invoiceFolder: "" }]]);
    b.answers[0](true);
    await settle();
    expect(b.setFolderFoundFor.mock.calls).toEqual([[null]]);
  });

  // The page's own applyDetail, which every reload of the customer lands through, run over recorded
  // setters and a guard that hands each payload straight through (a lifted test, not a source pin).
  function reload(stored: string) {
    const setFolderFoundFor = vi.fn();
    const [source] = declared(`src/${PAGE}`, "applyDetail");
    const applyDetail = run<(data: [Record<string, unknown>, unknown[], unknown[]]) => void>(source, {
      useCallback: (fn: unknown) => fn,
      editGuard: { applyPayload: (payload: unknown) => payload, applyRows: (_collection: string, rows: unknown) => rows },
      setC: vi.fn(), setAddresses: vi.fn(), setContacts: vi.fn(), setFolderFoundFor, percentFromFraction,
    });
    applyDetail([{ invoiceFolder: stored, salesTaxRate: null }, [], []]);
    expect(setFolderFoundFor).toHaveBeenCalledTimes(1);
    const [[update]] = setFolderFoundFor.mock.calls as [[(shownFor: string | null) => string | null]];
    return update;
  }

  it("a reload storing another folder (another session's save) takes the notice away", () => {
    expect(reload("Z:\\Customers\\Other")(ACME)).toBeNull();
  });

  it("a reload storing the folder the notice was shown for keeps it, and one shows none where none was shown", () => {
    expect(reload(ACME)(ACME)).toBe(ACME);
    expect(reload(ACME)(null)).toBeNull();
  });

  it("the notice is a status line, shown while it speaks for a folder (a source pin: no test renders the page)", () => {
    expect(renderedFrom(`src/${PAGE}`, "span").filter((text) => text.includes("FOLDER_FOUND"))).toEqual([
      'folderFoundFor !== null && <span role="status" className="ml-2 text-xs text-ink-800">{FOLDER_FOUND}</span>',
    ]);
  });

  it("the box is the page's blur-save shape, read-only without customers.edit", () => {
    const found = jsxTags(`src/${PAGE}`).filter((tag) => tag.name === "input" && tag.attr("onFocus") === 'noteFocusC("invoiceFolder")');
    expect(found.map((tag) => tag.text)).toHaveLength(1);
    const [input] = found;
    expect(input.attr("value")).toBe("c.invoiceFolder");
    expect(input.attr("readOnly")).toBe("!canEdit.allowed");
    expect(input.attr("title")).toBe("canEdit.title");
    expect(input.attr("onChange")).toBe("(e) => patchDraft({ invoiceFolder: e.target.value })");
    expect(input.attr("onBlur")).toBe("(e) => onBlurSave(e, {}, commitInvoiceFolder)");
  });
});
