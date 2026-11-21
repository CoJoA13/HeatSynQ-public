import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import ts from "typescript";

const sourceRoot = process.cwd();
function source(file: string) {
  const filename = path.join(sourceRoot, file);
  return { filename, parsed: ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) };
}

export function stopRuntime(options: { killed?: boolean; leaderExited?: boolean; signalError?: string } = {}) {
  const { filename, parsed } = source("e2e/run.mjs");
  const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "killDevServer");
  assert.ok(declaration, "Execute the actual stop declaration");
  const signals: { target: number; signal: string | number }[] = [];
  let groupAlive = true;
  const child = Object.assign(new EventEmitter(), {
    pid: 73100, killed: options.killed ?? false,
    exitCode: options.leaderExited ? 0 as number | null : null as number | null,
    signalCode: null as string | null,
    kill(signal: string) { child.killed = true; signals.push({ target: child.pid, signal }); return true; },
  });
  const privateProcess = {
    kill(target: number, signal: string | number) {
      assert.equal(target, -child.pid, "Only the owned process group can be probed/signalled");
      signals.push({ target, signal });
      if (!groupAlive) throw Object.assign(new Error("owned process group absent"), { code: "ESRCH" });
      if (options.signalError) throw Object.assign(new Error("cannot establish group state"), { code: options.signalError });
      return true;
    },
  };
  const stop = new Script(`${declaration.getText(parsed)}\nkillDevServer`, { filename }).runInNewContext({
    process: privateProcess, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, Error,
  }) as (server: typeof child, timeoutMs: number) => Promise<void>;
  return {
    stop: () => stop(child, 20), signals, child,
    groupGone() { groupAlive = false; },
    leaderExit() { child.exitCode = 0; child.emit("exit", 0, null); },
  };
}

type Reply = { ok(): boolean; json(): Promise<Record<string, unknown>>; url(): string; request(): { method(): string } };
type Watch = { handled: boolean; settled: boolean; accept(reply: Reply): boolean; reject(error: Error): void };
// Only the fake transport's internal promises are suppressed; handled records whether actual
// candidate code attached a rejection handler, including through a derived .then chain.
function observed<T>(promise: Promise<T>, watch: { handled: boolean }): PromiseLike<T> {
  void promise.catch(() => {});
  return { then(onfulfilled, onrejected) {
    if (typeof onrejected === "function") watch.handled = true;
    return observed(promise.then(onfulfilled, onrejected), watch);
  } };
}
export function fixtureRuntime(options: {
  failAt?: string;
  mode?: "click" | "response" | "after-response";
  error?: Error;
  orderContinuationError?: Error;
} = {}) {
  const { filename, parsed } = source("e2e/lib/draft-recovery-fixtures.mjs");
  const body = parsed.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(parsed).replace(/^export\s+/, "")).join("\n");
  const watchers: Watch[] = [];
  const boundary: { name: string; handled: boolean }[] = [];
  const writes: string[] = [];
  let orderNumber = 0, invoiceNumber = 0, fieldNumber = 0;
  let currentOrder = "", currentInvoice = "";
  const reply = (endpoint: string, body: Record<string, unknown>): Reply => ({
    ok: () => true, json: async () => body, url: () => `http://fixture.invalid${endpoint}`,
    request: () => ({ method: () => endpoint.endsWith("/containers") || endpoint.endsWith("/charges") || endpoint.includes("/lines/") ? "PUT" : endpoint === "/api/quotes/quote-1" ? "PATCH" : "POST" }),
  });
  const emit = (endpoint: string, body: Record<string, unknown>) => {
    writes.push(endpoint); const res = reply(endpoint, body);
    const match = watchers.find(watch => !watch.settled && watch.accept(res));
    assert.ok(match, `Actual production waiter must match ${endpoint}`);
  };
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const emitAction = (name: string) => {
    if (name === "Save containers") emit(`/api/orders/${currentOrder}/containers`, {});
    if (name === "Save serials") emit(`/api/orders/${currentOrder}/lines/line-1/serials`, {});
    if (name === "Save shipment") emit("/api/shippers", { shipper: { id: `shipment-${orderNumber}` } });
    if (name === "Create invoices") { currentInvoice = `invoice-${++invoiceNumber}`; emit("/api/invoices", { invoice: { id: currentInvoice } }); }
    if (name === "Finalize invoice") emit(`/api/invoices/${currentInvoice}/finalize`, {}); // the header's label (PR 6)
    if (name === "Add payment") emit("/api/receivables/batches/batch-1/payments", { payments: [{ id: "payment-1", reference: "DR273-RAW-RECOVERY-PAYMENT" }] });
    if (name === "New quote") emit("/api/quotes", { id: "quote-1" });
    if (name === "Save quote") emit("/api/quotes/quote-1", {}); // the quote page's Save (PR 3's rename)
    if (name === "Add") emit("/api/admin/part-fields", { id: `field-${++fieldNumber}` });
    if (name === "Create template") emit("/api/templates", { id: "document-1", draft: { id: "version-1", versionNumber: 1 } });
    if (name === "Save charges") emit(`/api/orders/${currentOrder}/charges`, {});
  };
  // Locator operations are external UI effects. The setup's actual control flow, waiter creation,
  // response admission, identity tracking and descriptor publication are executed unchanged.
  class Locator {
    constructor(readonly name = "") {}
    locator() { return new Locator(this.name); }
    filter() { return new Locator(this.name); }
    first() { return this; }
    getByRole(_role: string, opts: { name?: string } = {}) { return new Locator(opts.name); }
    getByLabel(name: string) { return new Locator(name); }
    getByPlaceholder(name: string) { return new Locator(name); }
    getByText(name: string) { return new Locator(name); }
    async selectOption() {}
    async fill() {}
    async check() {}
    async press() {}
    async waitFor() {}
    async getAttribute() { return "/certs/cert-1"; }
    async click() {
      const pending = watchers.filter(watch => !watch.settled).at(-1);
      if (pending) boundary.push({ name: this.name, handled: pending.handled });
      if (this.name === options.failAt) {
        const error = options.error ?? new Error("fixture click failed");
        if (options.mode === "response") { assert.ok(pending); pending.reject(error); return; }
        if (options.mode === "after-response") { emitAction(this.name); await tick(); }
        throw error;
      }
      emitAction(this.name);
    }
  }
  const page = Object.assign(new Locator(), {
    async goto() {},
    waitForResponse(predicate: (res: Reply) => boolean) {
      let resolve!: (reply: Reply) => void, reject!: (error: Error) => void;
      const promise = new Promise<Reply>((yes, no) => { resolve = yes; reject = no; });
      const watch: Watch = { handled: false, settled: false,
        accept(res) { if (!predicate(res)) return false; watch.settled = true; resolve(res); return true; },
        reject(error) { watch.settled = true; reject(error); },
      };
      watchers.push(watch); return observed(promise, watch);
    },
  });
  const seed = {
    customerCode: "OWNED", customerId: "customer-1", containerTypeId: "container-1", paymentTypeId: "payment-type-1",
    parts: Array.from({ length: 6 }, (_, index) => ({ id: `part-${index}`, partNumber: `OWNED-${index}` })),
    priceCodeId: "price-code", fieldNames: ["Own text", "Own number", "Own checkbox"], inspectionNames: ["Own hardness", "Own case"],
    documentTemplateName: "Own document", batchMarker: "own exact batch marker",
    stepCodeA: { code: "OWN-A", name: "Own A" }, stepCodeB: { code: "OWN-B", name: "Own B" },
  };
  const owned = { phase: "seeded", ids: [] as { kind: string; id: string }[] };
  const ctx = { baseURL: "http://fixture.invalid", fixtures: { draftRecoverySeed: seed } as { draftRecoverySeed: typeof seed; draftRecovery?: unknown },
    created: { draftRecovery: owned, receivablesBatchId: "other-batch" },
    async apiMutate(_page: unknown, url: string, config: { method: string; data: { notes: string } }) {
      assert.equal(url, "http://fixture.invalid/api/receivables/batches"); assert.equal(config.method, "POST");
      assert.equal(config.data.notes, seed.batchMarker); writes.push(url); return reply("/api/receivables/batches", { id: "batch-1" });
    },
  };
  const prepare = new Script(`${body}\nprepareDraftRecoveryFixtures`, { filename }).runInNewContext({
    assert, URL, Date,
    createOrderViaUi: async () => {
      currentOrder = `order-${++orderNumber}`; emit("/api/orders", { order: { id: currentOrder } });
      await tick(); if (options.orderContinuationError) throw options.orderContinuationError;
      return { id: currentOrder, number: orderNumber };
    },
    startNewShipment: async () => {}, orderPanel: () => new Locator(),
    // PR 2: the hub's sections sit in tabs; the fixture reaches them through these (e2e/lib/orders.mjs).
    hubSection: async (_page: unknown, heading: string) => new Locator(heading), openOrderTab: async () => {},
    openRecordTab: async () => {}, // the invoice fixture opens its Lines tab (PR 6)
    waitForShipmentPage: async () => ({ id: `shipment-${orderNumber}`, shipperNumber: orderNumber }),
    waitForValue: async () => {},
  }) as (page: unknown, ctx: unknown) => Promise<unknown>;
  return { run: () => prepare(page, ctx), owned, ctx, boundary, writes, watchers,
    rejectPending(error: Error) { for (const watch of watchers) if (!watch.settled) watch.reject(error); },
  };
}
