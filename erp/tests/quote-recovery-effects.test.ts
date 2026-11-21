import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession, EMPTY_DRAFT_SUMMARY } from "../src/lib/draft-session";
import { quoteBaselineFrom, quoteDraftFrom, quoteRecoveryAdapter } from "../src/lib/quote-recovery";
import { selectDraftCount, selectDraftIdentity } from "../src/lib/draft-summary-select";
import type { QuoteDetailData } from "../src/app/quotes/quote-form";

// Execute the actual component prefix through its load effect, including every preceding
// hook/callback, plus the actual shared hooks. JSX/actions after that effect are outside
// this scheduling test's boundary. The runtime models dependency comparison and committed
// effects; notifications coalesce until flush. It does not claim React concurrent rendering.
function compile(source: string, environment: Record<string, unknown>) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), js)(...Object.values(environment));
}
function runtime() {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void; setter?: (value: unknown) => void };
  const slots: Slot[] = []; let cursor = 0; let renderNeeded = true;
  let queued: (() => void)[] = []; let render: () => void = () => {};
  const changed = (a: readonly unknown[] | undefined, b: readonly unknown[]) => !a || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  function useState(initial: unknown) {
    const index = cursor++; const slot = slots[index] ??= { value: initial };
    slot.setter ??= value => {
      const next = typeof value === "function" ? value(slot.value) : value;
      if (!Object.is(next, slot.value)) { slot.value = next; renderNeeded = true; }
    };
    return [slot.value, slot.setter];
  }
  function useEffect(effect: () => (() => void) | void, deps: readonly unknown[]) {
    const slot = slots[cursor++] ??= {};
    if (changed(slot.deps, deps)) {
      slot.deps = deps;
      queued.push(() => { slot.cleanup?.(); slot.cleanup = effect() ?? undefined; });
    }
  }
  const hooks = {
    useState, useEffect,
    useRef(initial: unknown) { const slot = slots[cursor++] ??= { value: { current: initial } }; return slot.value; },
    useId() { const index = cursor++; return `lease-${index}`; },
    useCallback(callback: unknown, deps: readonly unknown[]) {
      const slot = slots[cursor++] ??= {};
      if (changed(slot.deps, deps)) { slot.deps = deps; slot.value = callback; }
      return slot.value;
    },
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, snapshot: () => unknown) {
      useEffect(() => subscribe(() => { renderNeeded = true; }), [subscribe]);
      return snapshot();
    },
  };
  return { hooks, mount(fn: () => void) { render = fn; }, async flush() {
    for (let turn = 0; turn < 30; turn++) {
      if (renderNeeded) { renderNeeded = false; cursor = 0; render(); const effects = queued; queued = []; effects.forEach(effect => effect()); }
      await Promise.resolve();
    }
    expect(renderNeeded).toBe(false);
  } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
const saved: QuoteDetailData = {
  id: "quote-a", quoteNumber: 101, status: "OPEN", expired: false, customerId: "customer-a", customerCode: "ACME", customerName: "Example",
  contactId: null, contactName: "", quoteDate: "2026-09-12", effectiveDate: "2026-09-12", expiryDate: "2026-10-12", followUpDate: null,
  rfqNumber: "Saved", quotedById: "user-a", quotedByName: "Quinn", endingStatementId: null, endingStatementName: "", endingStatementText: "",
  closeReason: "", closedAt: null, closedByName: "", notes: "", internalNotes: "", deletedAt: null, lines: [],
};

describe("QuoteDetail committed authorization read scheduling", () => {
  for (const dirty of [false, true]) it(`automatically rereads after a coalesced same-user check (${dirty ? "dirty" : "clean"}) and rejects the prior callback`, async () => {
    const store = createDraftStore(); const session = createDraftSession(store);
    await session.validateIdentity(async () => ({ id: "u1" }));
    const hooks = runtime(); const requests: ReturnType<typeof deferred<QuoteDetailData>>[] = []; const urls: string[] = [];
    const permissions = ["quotes.view", "quotes.edit"];
    const api = (url: string) => {
      urls.push(url);
      if (url === "/api/quotes/quote-a") { const request = deferred<QuoteDetailData>(); requests.push(request); return request.promise; }
      if (url === "/api/auth/me") return Promise.resolve({ id: "u1", permissions });
      if (url.startsWith("/api/picklists/")) return Promise.resolve([]);
      throw new Error(`Unexpected request: ${url}`);
    };
    const hookText = readFileSync(new URL("../src/lib/use-recoverable-draft.ts", import.meta.url), "utf8");
    const hookAst = ts.createSourceFile("hooks.ts", hookText, ts.ScriptTarget.Latest, true);
    const hookBody = hookAst.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(hookAst).replace(/^export /, "")).join("\n");
    const shared = compile(`${hookBody}\nreturn { useBrowserDraftStore, useDraftIdentity, useRecoverableDraft };`, {
      ...hooks.hooks, EMPTY_DRAFT_SUMMARY, selectDraftIdentity, selectDraftCount, getBrowserDraftStore: () => store,
    });
    const text = readFileSync(new URL("../src/app/quotes/[id]/QuoteDetail.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("QuoteDetail.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "QuoteDetail") as ts.FunctionDeclaration;
    const statements = component.body!.statements;
    const loadIndex = statements.findIndex(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "load"));
    expect(loadIndex).toBeGreaterThan(0);
    expect(statements[loadIndex + 1].getText(ast)).toContain("useEffect");
    const prefix = statements.slice(0, loadIndex + 2).map(statement => statement.getText(ast)).join("\n");
    const componentReadPath = compile(`return function QuoteDetail({ id }) { ${prefix}\n return { load, view, readIdRef }; };`, {
      ...hooks.hooks, ...shared, useRouter: () => ({}), usePermissions: () => ({ permissions, error: null }),
      getBrowserDraftSession: () => session, peekBrowserDraftSession: () => session,
      quoteBaselineFrom, quoteDraftFrom, quoteRecoveryAdapter, api,
      EMPTY_BREAK_DRAFT: { threshold: "", price: "" },
    }) as (props: { id: string }) => { load: () => Promise<void>; readIdRef: { current: number } };
    let output!: ReturnType<typeof componentReadPath>;
    hooks.mount(() => { output = componentReadPath({ id: "quote-a" }); });
    await hooks.flush(); expect(requests).toHaveLength(1);
    requests[0].resolve(saved); await hooks.flush();
    const owner = store.getSnapshot().owner!;
    const binding = store.bind({ owner, record: { kind: "quote", id: "quote-a" }, editor: quoteRecoveryAdapter.kind }, { label: "Quote", href: "/quotes/quote-a" }, quoteRecoveryAdapter);
    expect(binding.getSnapshot().mode).toBe("editing");
    if (dirty) binding.change(data => ({ ...data, header: { ...data.header, rfqNumber: "Retained raw" } }));
    await hooks.flush();
    // Start a real prior load and leave GET unresolved. This call sets up the stale race;
    // the third request below must come exclusively from the production committed effect.
    const prior = output.load(); expect(requests).toHaveLength(2);
    const before = session.getReadAuthorizationRevision();
    await session.validateIdentity(async () => ({ id: "u1" }));
    expect(session.getReadAuthorizationRevision()).not.toBe(before);
    expect(store.getSnapshot().owner).toBe(owner);
    await hooks.flush();
    expect(requests).toHaveLength(3);
    requests[2].resolve(saved); await hooks.flush();
    // #618: the prior load dispatched /me beside its quote GET, so three, not two; the catalogs still
    // wait for the quote, so the step-code count below is unchanged.
    expect(urls.filter(url => url === "/api/auth/me")).toHaveLength(3);
    expect(urls.filter(url => url.includes("processStepCode"))).toHaveLength(2);
    expect(binding.getSnapshot().mode).toBe(dirty ? "offer" : "editing");
    requests[1].resolve({ ...saved, rfqNumber: "STALE CALLBACK" }); await prior; await hooks.flush();
    expect(binding.getSnapshot().savedBaseline?.header.rfqNumber).toBe("Saved");
    if (dirty) {
      expect(binding.getSnapshot().canRestore).toBe(true);
      const view = binding.getSnapshot();
      expect(view.current?.data.header.rfqNumber).toBe("Retained raw");
      expect(binding.restore(view.current!.stamp, output.readIdRef.current)).toBe(true);
      expect(binding.getSnapshot().mode).toBe("editing");
    }
  });
});
