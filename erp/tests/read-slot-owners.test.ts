// P6 step 2 (#654, #639, #632 bug b, #636's four clears): every read owns its message slot, and a
// success clears only its own. A picker read's failure gets a line of its own, never the page's
// action slot `error`, which the record read and every action's success set back to null; and a
// read or action that writes a message clears that message when it next succeeds.
//
// The production effects and handlers run here over environments the test builds
// (tests/helpers/lift-callback.ts), so each case is the code that ships, not a copy of it. The
// sweep at the end walks every client file and refuses a picker read whose `.catch` writes
// `setError`: it fails closed, with no allowlist.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { callback, runNode, source } from "./helpers/lift-callback";
import { oneShotHold } from "../src/lib/single-flight";

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const fail = (message: string) => () => Promise.reject(new Error(message));

/** The `useEffect` callback in `path` whose text holds `marker` (and not `unless`); exactly one must. */
function effect(path: string, marker: string, unless?: string) {
  const file = source(path); const found: ts.Expression[] = [];
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
      && node.arguments[0]?.getText(file).includes(marker)
      && !(unless && node.arguments[0].getText(file).includes(unless))) found.push(node.arguments[0]);
    ts.forEachChild(node, walk);
  }
  walk(file);
  expect(found, `${path}: one useEffect holding ${marker}`).toHaveLength(1);
  return { node: found[0], file };
}
const runEffect = (path: string, marker: string, env: Record<string, unknown>, unless?: string) => {
  const { node, file } = effect(path, marker, unless);
  return runNode<() => unknown>(node, file, env)();
};

describe("a picker read's failure has a line of its own (#654, #639)", () => {
  const cases: { name: string; path: string; marker: string; env: Record<string, unknown>; own: string }[] = [
    { name: "receipt batch payer", path: "app/receivables/batches/[id]/BatchDetail.tsx", marker: '"/api/customers"',
      env: { customersGate: { allowed: true }, setCustomers: vi.fn() }, own: "addLoadError" },
    { name: "receipt batch payment type", path: "app/receivables/batches/[id]/BatchDetail.tsx", marker: "/api/picklists/paymentType",
      env: { setPaymentTypes: vi.fn() }, own: "addLoadError" },
    { name: "A/R aging customer filter", path: "app/receivables/aging/AgingReport.tsx", marker: '"/api/customers"',
      env: { customersGate: { allowed: true }, setCustomers: vi.fn() }, own: "setCustomersError" },
    { name: "quotes customer filter", path: "app/quotes/Quotes.tsx", marker: '"/api/customers"',
      env: { customersGate: { allowed: true }, setCustomers: vi.fn() }, own: "addOptionsError" },
    { name: "quotes part picker", path: "app/quotes/Quotes.tsx", marker: '"/api/parts"',
      env: { partsGate: { allowed: true }, setParts: vi.fn() }, own: "addOptionsError" },
    { name: "order board customer filter", path: "app/page.tsx", marker: "/api/customers?includeInactive=1",
      env: { customersGate: { allowed: true }, setCustomers: vi.fn() }, own: "setCustomersError" },
    { name: "order board saved views", path: "app/page.tsx", marker: "/api/saved-views",
      env: { setSavedViews: vi.fn(), setColumns: vi.fn(), setFilters: vi.fn(), setSort: vi.fn(), setSelectedViewId: vi.fn(),
        normalizeViewConfig: vi.fn(), setViewsReady: vi.fn() }, own: "setViewsLoadError" },
    { name: "parts list customer picker", path: "app/parts/page.tsx", marker: '"/api/customers"',
      env: { customersGate: { allowed: true }, setCustomers: vi.fn() }, own: "setCustomersError" },
    // The template preview's record picker (PR C of #926, Task 6's fix round): the live page's run
    // clears the run's own `error` on every settled edit, so the list read keeps a line of its own.
    { name: "template preview record picker", path: "app/admin/templates/[id]/edit/PreviewPane.tsx", marker: "spec.listPath",
      env: { access: "allowed", spec: { listPath: "/api/orders", kind: "order" }, setOptions: vi.fn(), optionsFor: vi.fn() },
      own: "setListError" },
  ];
  for (const c of cases) it(c.name, async () => {
    const setError = vi.fn(); const own = vi.fn();
    runEffect(c.path, c.marker, { ...c.env, api: fail("Request failed (503)"), setError, [c.own]: own });
    await flush();
    expect(setError).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledOnce();
    expect(String(own.mock.calls[0][0])).toContain("Request failed (503)");
  });

  it("statements customer filter: its own line, and Print still falls open", async () => {
    const setError = vi.fn(); const setCustomersError = vi.fn(); const setFamilyLookup = vi.fn();
    const { node, file } = effect("app/receivables/statements/Statements.tsx", "/api/customers?includeInactive=1");
    const cleanup = runNode<() => unknown>(node, file, {
      customersAllowed: true, setCustomers: vi.fn(), setFamilyLookup, setError, setCustomersError,
      api: fail("Request failed (503)"),
    })();
    await flush();
    expect(setError).not.toHaveBeenCalled();
    expect(setCustomersError).toHaveBeenCalledWith("Request failed (503)");
    expect(setFamilyLookup).toHaveBeenCalledWith("unknown");
    expect(typeof cleanup).toBe("function");
  });

  it("pick-list options behind a column: their own line, not the table's action slot", async () => {
    const setError = vi.fn(); const setOptionsError = vi.fn();
    runEffect("components/ReferenceTable.tsx", "Could not load pick lists", {
      refLinks: [{ column: "glAccountId", targetKind: "glAccount" }], setRefOptions: vi.fn(),
      api: fail("Request failed (503)"), setError, setOptionsError,
    });
    await flush();
    expect(setError).not.toHaveBeenCalled();
    expect(setOptionsError).toHaveBeenCalledWith("Could not load pick lists: Request failed (503)");
  });

  it("the batch's picker lines add up, and the action slot's clear leaves them", () => {
    // `addLoadError` is the ShipmentDetail shape: two failures read as one line, and nothing but a
    // reload clears it. The page's actions write `error` alone.
    const file = source("app/receivables/batches/[id]/BatchDetail.tsx");
    const text = file.getText();
    expect(text).toMatch(/const addLoadError = useCallback\(\(message: string\) => \{\s*setLoadError\(\(cur\) => \(cur \? `\$\{cur\} \$\{message\}` : message\)\);/);
    expect(text).not.toMatch(/setLoadError\(null\)/);
  });
});

describe("the receipt batch's record read owns its own line (#654, P6 CORR)", () => {
  const path = "app/receivables/batches/[id]/BatchDetail.tsx";
  it("a failed first read reports in initialLoadError, never the action slot", async () => {
    const setError = vi.fn(); const setInitialLoadError = vi.fn();
    runEffect(path, "load().catch", { load: fail("Request failed (404)"), setError, setInitialLoadError }, "consumeSelectedPayment");
    await flush();
    expect(setError).not.toHaveBeenCalled();
    expect(setInitialLoadError).toHaveBeenCalledWith("Request failed (404)");
  });
  // The clear sits in `load` itself (#783 review), so every accepted read clears the line, not the
  // mount's alone: a selection read or Void's refresh that lands shows current data.
  const runLoad = async (accepted: boolean) => {
    const f = source(path); let found: ts.Node | undefined;
    function walk(n: ts.Node) {
      if (ts.isVariableDeclaration(n) && n.name.getText(f) === "load" && n.initializer) found = n.initializer;
      ts.forEachChild(n, walk);
    }
    walk(f); expect(found).toBeDefined();
    const setError = vi.fn(); const setInitialLoadError = vi.fn();
    const load = runNode<() => Promise<unknown>>(found!, f, {
      useCallback: (fn: unknown) => fn, id: "b1", api: () => Promise.resolve({ id: "b1" }),
      mutations: { next: () => 1, accept: () => accepted },
      recoverySource: { begin: () => ({ accept: () => Promise.resolve(), unavailable: vi.fn() }) },
      editGuard: { applyPayload: (p: unknown) => p }, setBatch: vi.fn(), setError, setInitialLoadError,
    });
    await load();
    return { setError, setInitialLoadError };
  };
  it("an accepted read clears its own line and leaves the action slot alone", async () => {
    const r = await runLoad(true);
    expect(r.setError).not.toHaveBeenCalled();
    expect(r.setInitialLoadError).toHaveBeenCalledWith(null);
  });
  it("a superseded read clears nothing", async () => {
    const r = await runLoad(false);
    expect(r.setError).not.toHaveBeenCalled();
    expect(r.setInitialLoadError).not.toHaveBeenCalled();
  });
  it("the selection read's failure goes to the same line", async () => {
    const setError = vi.fn(); const setInitialLoadError = vi.fn();
    const session = { readAuthorizationTicket: () => "ticket", isReadAuthorized: () => true };
    runEffect(path, "consumeSelectedPayment", {
      getBrowserDraftSession: () => session, drafts: { identityReady: true }, selectionRevision: 1,
      load: fail("Request failed (503)"), consumeSelectedPayment: vi.fn(), setExpandedPaymentId: vi.fn(),
      setError, setInitialLoadError,
    });
    await flush();
    expect(setError).not.toHaveBeenCalled();
    expect(setInitialLoadError).toHaveBeenCalledWith("Request failed (503)");
  });
});

describe("a list read clears its own message when it next lands (#632 bug b, P6 CORR)", () => {
  // The three documents lists' clear moved into the shared `useStoredDocuments` (P6 step 3), whose
  // read is run from its source in tests/list-status.test.tsx ("a failed read then a landed one").
  const latest = () => ({ next: () => 1, isCurrent: () => true });
  it("the parts list's read owns listError: a failure lands there and a later read clears it", async () => {
    const { node, file } = (() => {
      const f = source("app/parts/page.tsx"); let found: ts.Node | undefined;
      function walk(n: ts.Node) {
        if (ts.isVariableDeclaration(n) && n.name.getText(f) === "load" && n.initializer) found = n.initializer;
        ts.forEachChild(n, walk);
      }
      walk(f); expect(found).toBeDefined(); return { node: found!, file: f };
    })();
    const env = (api: () => Promise<unknown>) => {
      const setError = vi.fn(); const setListError = vi.fn();
      const load = runNode<() => Promise<void>>(node, file, {
        useCallback: (fn: unknown) => fn, latest: latest(), query: "", api, setRows: vi.fn(), setLoaded: vi.fn(),
        setError, setListError,
      });
      return { load, setError, setListError };
    };
    const failed = env(fail("Request failed (503)"));
    await failed.load();
    expect(failed.setError).not.toHaveBeenCalled();
    expect(failed.setListError).toHaveBeenCalledWith("Request failed (503)");
    const landed = env(() => Promise.resolve([]));
    await landed.load();
    expect(landed.setError).not.toHaveBeenCalled();
    expect(landed.setListError).toHaveBeenCalledWith(null);
  });
});

describe("users and roles clear their message on success (#636)", () => {
  // `load` answers true only when it was the current read and landed.
  const ok = () => Promise.resolve(true);
  it("users: create", async () => {
    const setError = vi.fn();
    await callback<() => Promise<void>>("app/admin/users/page.tsx", "UsersPage", "create", {
      api: ok, load: ok, form: { roleId: "" }, setForm: vi.fn(), setError, setAddMessage: vi.fn(), createHold: oneShotHold(),
    })();
    expect(setError).toHaveBeenLastCalledWith(null);
  });
  it("users: patch", async () => {
    const setError = vi.fn();
    await callback<(id: string, body: object) => Promise<void>>("app/admin/users/page.tsx", "UsersPage", "patch", {
      api: ok, load: ok, invalidateSetupBanner: vi.fn(), setError, setRowMessage: vi.fn(),
    })("u1", { title: "x" });
    expect(setError).toHaveBeenLastCalledWith(null);
  });
  it("roles: create", async () => {
    const setError = vi.fn();
    await callback<() => Promise<void>>("app/admin/roles/page.tsx", "RolesPage", "create", {
      api: ok, load: ok, newName: "Clerk", setNewName: vi.fn(), setError, setAddMessage: vi.fn(), createHold: oneShotHold(),
    })();
    expect(setError).toHaveBeenLastCalledWith(null);
  });
  it("roles: toggle", async () => {
    const setError = vi.fn();
    const saveQueue = { current: Promise.resolve() };
    await callback<(roleId: string, permission: string) => Promise<void>>("app/admin/roles/page.tsx", "RolesPage", "toggle", {
      api: ok, load: ok, saveQueue, rolesRef: { current: [{ id: "r1", permissions: [] }] }, setError, setPermissionsMessage: vi.fn(),
    })("r1", "orders.view");
    expect(setError).toHaveBeenLastCalledWith(null);
  });
});

// The census: every client file's `.catch` on a promise chain that reads a picker (customers,
// parts, pick lists, the admin reference lists) must not write `setError`. Recognised by the
// request's literal text anywhere in the `.catch` receiver, so a `Promise.all` over several reads
// counts too. It over-matches on purpose and has no allowlist: a picker read with nowhere of its
// own to report is a decision to make in the page, not here.
const PICKER = /["`]\/api\/(customers|parts|picklists\/|admin\/reference\/)/;
function clientFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "api" ? [] : clientFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}
function writesSetError(node: ts.Node): boolean {
  let hit = false;
  function walk(n: ts.Node) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "setError") hit = true;
    if (ts.isIdentifier(n) && n.text === "setError" && !ts.isCallExpression(n.parent)) hit = true;
    ts.forEachChild(n, walk);
  }
  walk(node); return hit;
}
describe("no picker read's .catch writes the action slot (sweep)", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files = clientFiles(root);
  it("finds the client files it sweeps", () => {
    expect(files.length).toBeGreaterThan(50);
  });
  it("refuses every picker .catch that writes setError", () => {
    const offenders: string[] = []; let seen = 0;
    for (const full of files) {
      const text = readFileSync(full, "utf8");
      const file = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function walk(n: ts.Node) {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch"
          && PICKER.test(n.expression.expression.getText(file))) {
          seen += 1;
          if (n.arguments.some(writesSetError)) offenders.push(`${full.slice(root.length + 1)}:${file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1}`);
        }
        ts.forEachChild(n, walk);
      }
      walk(file);
    }
    // The sweep reached the picker reads it exists for (a detector that sees none proves nothing).
    expect(seen).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});

// A superseded refresh resolves false on either path (Codex on #783): the handler waiting on it must
// not clear, or it hides a newer refresh's failure over a stale table.
describe("users and roles leave the message alone after a superseded refresh (#783 review)", () => {
  const ok = () => Promise.resolve({});
  const superseded = () => Promise.resolve(false);
  const handlers: [string, string, string, Record<string, unknown>, unknown[]][] = [
    ["app/admin/users/page.tsx", "UsersPage", "create", { form: { roleId: "" }, setForm: vi.fn(), setAddMessage: vi.fn(), createHold: oneShotHold() }, []],
    ["app/admin/users/page.tsx", "UsersPage", "patch", { invalidateSetupBanner: vi.fn(), setRowMessage: vi.fn() }, ["u1", { title: "x" }]],
    ["app/admin/roles/page.tsx", "RolesPage", "create", { newName: "Clerk", setNewName: vi.fn(), setAddMessage: vi.fn(), createHold: oneShotHold() }, []],
    ["app/admin/roles/page.tsx", "RolesPage", "toggle", { saveQueue: { current: Promise.resolve() }, rolesRef: { current: [{ id: "r1", permissions: [] }] }, setPermissionsMessage: vi.fn() }, ["r1", "orders.view"]],
  ];
  for (const [path, owner, name, env, args] of handlers) it(`${owner}.${name}`, async () => {
    const setError = vi.fn();
    await callback<(...a: unknown[]) => Promise<void>>(path, owner, name, { ...env, api: ok, load: superseded, setError })(...args);
    expect(setError).not.toHaveBeenCalled();
  });
  it("each page's load answers false when superseded and true when it landed", () => {
    for (const path of ["app/admin/users/page.tsx", "app/admin/roles/page.tsx"]) {
      const text = source(path).getText();
      expect(text).toMatch(/if \(!latest\.isCurrent\(ticket\)\) return false; \/\/ a slower/);
      expect(text).toMatch(/if \(!latest\.isCurrent\(ticket\)\) return false;\n\s+throw e;/);
      expect(text).toMatch(/return true;\n\s+\} catch/);
    }
  });
});
