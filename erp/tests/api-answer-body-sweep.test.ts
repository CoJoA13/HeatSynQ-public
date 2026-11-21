import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DYNAMIC, HTTP_METHODS, foldUrl, methodOf, routePattern, urlConstants, urlMatchesRoute } from "./helpers/ts-parse";

/**
 * #569: no route answers an `api()` caller with a 2xx and no body.
 *
 * WHY. #547's ruling ("a 2xx proves the write committed") reads a 2xx whose body cannot be read as
 * "saved, but the answer could not be read" (`UnreadableAnswerError`, `src/lib/fetcher.ts`). That is
 * honest only while no route a client reaches through `api()` answers 2xx with no body on purpose: such
 * a route would show the "could not be read" sentence on every call. It was a one-off census at
 * `6e42469`; this sweep makes it standing.
 *
 * HOW, in two halves joined by URL, the archival-gate sweep's join (`tests/helpers/ts-parse.ts`).
 *
 * The CLIENT half finds every call under `src/` (not `src/app/api`, not `src/server`) whose first
 * argument folds to a URL beginning `/api/`, and classifies it by its callee: `api` and the named
 * wrappers that forward their URL into it (`JSON_WRAPPERS`) are the census; a raw reader
 * (`RAW_READERS`, which read the `Response` themselves and never through `api()`) and a string method
 * (`NOT_REQUESTS`) are not. An unclassified callee FAILS: a new wrapper is a decision written here,
 * never a silent hole. An `api()` call whose URL does not fold is an `OPAQUE_API` entry naming the URLs
 * it can carry (listed, or derived from the literals handed to a named prop), so a prop-fed URL stays
 * inside the census instead of becoming an amnesty.
 *
 * The ROUTE half asks the TypeScript checker, never a pattern, for each reached handler's awaited
 * return type. Every member of it must be `NextResponse<X>`, and no member of `X` may be `undefined`,
 * `void`, `any` or `unknown`: `NextResponse.json(undefined)` sends no body, and `any`/`unknown` can
 * hide one. A bare `Response`, `new NextResponse(null, { status: 204 })` and an erased
 * `Promise<NextResponse>` annotation all read as a refusal, which a syntactic denylist would miss
 * (the issue's reason for the checker). `null` is accepted: `NextResponse.json(null)` sends the four
 * bytes `null`, which `res.json()` reads. Only the top level matters; an object holding an `unknown`
 * field still serialises. A thrown error is `handle()`'s JSON 4xx/5xx, never a 2xx, so throws are out
 * of scope.
 *
 * `BODYLESS_ALLOWED` is the exemption list, an entry with a reason; it is pinned EMPTY.
 *
 * ONE PROGRAM. Building the checker costs about two seconds, so the file builds one lazily and shares
 * it with every case; the detector cases' synthetic routes are extra root files of that same program,
 * overlaid under the project root so `next/server` and `@/` resolve as they do for a real route.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SRC = join(ROOT, "src");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

function srcFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((p) => `src/${p.split(sep).join("/")}`)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
    .sort();
}
const clientFiles = (): string[] =>
  srcFiles().filter((f) => !f.startsWith("src/app/api/") && !f.startsWith("src/server/"));
const routeFiles = (): string[] => srcFiles().filter((f) => f.startsWith("src/app/api/") && f.endsWith("/route.ts"));

const parse = (file: string, src: string): ts.SourceFile =>
  ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

// ---------------------------------------------------------------------------------------------
// THE CLIENT HALF
// ---------------------------------------------------------------------------------------------

/** Callees that send a URL into `api()` on the caller's behalf, by name. A name, not a file: a second
 *  function of the same name reached with an `/api/` URL is checked too, which fails closed. Each
 *  forwards through an `api()` call of its own that `OPAQUE_API` lists. */
const JSON_WRAPPERS: ReadonlyMap<string, string> = new Map([
  ["call", "the customer page's in-flight de-duplicating wrapper (`customers/[id]/page.tsx`): `await api(path, init)`"],
  ["read", "new-shipment-recovery's injected reader, which `NewShipment.tsx` supplies as `path => api<unknown>(path)`"],
  ["useStoredDocuments", "the stored-documents list hook (`src/lib/use-stored-documents.ts`): `api<T[]>(url)`"],
]);

/** Callees that take an `/api/` URL and read the `Response` themselves (or let the browser read it),
 *  never through `api()`, so a body-less answer is theirs to handle, not #547's. */
const RAW_READERS: ReadonlyMap<string, string> = new Map([
  ["trackedFetch", "a print's Blob and `x-document-id`, and the FormData uploads: the raw Response (`src/lib/fetcher.ts`)"],
  ["fetch", "the raw Response; `tests/unsaved-registration-sweep.test.ts` already confines a bare fetch"],
  ["tab.show", "puts a stored document's URL in a tab the print opened (`src/lib/print-tab.ts`); the browser reads it"],
]);

/** Calls whose first argument is an `/api/` string but which send nothing: string methods asking
 *  whether a path is an API path. Keyed `file::callee`. */
const NOT_REQUESTS: ReadonlyMap<string, string> = new Map([
  ["src/lib/draft-session.ts::path.split(\"?\")[0].startsWith", "asks whether a path is an auth call; sends nothing"],
  ["src/lib/draft-session.ts::path.startsWith", "asks whether a path is an API call; sends nothing"],
  ["src/lib/unsaved-guard.ts::path.startsWith", "asks whether a path is an API call; sends nothing"],
]);

type Derived = { kind: "jsx-attr" | "property"; name: string };
/** Every `api()` call whose URL does not fold, keyed `file::argument text`, with the URLs it can carry.
 *  `urls` lists client-shaped URLs (holes as `*`); `derive` folds every `/api/` literal handed to the
 *  named JSX attribute or object property anywhere under `src/`, so a new `<PasteGrid endpoint=…>`
 *  enters the census by itself. `forwards` marks a forwarder whose callers are routed sites of their
 *  own (a `JSON_WRAPPERS` callee). The site's own method applies. */
const OPAQUE_API: ReadonlyMap<string, { urls?: readonly string[]; derive?: Derived; forwards?: string; reason: string }> = new Map([
  ["src/components/AttachmentsSection.tsx::`${basePath}/${att.id}`", {
    urls: ["/api/*/*/attachments/*"],
    reason: "an attachment's DELETE; `basePath` is the file's own `/api/${AREA_PATH[owner]}/${ownerId}/attachments`",
  }],
  ["src/components/PasteGrid.tsx::endpoint", {
    derive: { kind: "jsx-attr", name: "endpoint" },
    reason: "the paste grid's POST to the endpoint its page hands it",
  }],
  ["src/app/admin/templates/[id]/edit/PreviewPane.tsx::spec.listPath", {
    derive: { kind: "property", name: "listPath" },
    reason: "the preview's record list, from `previewSpec` in `src/lib/template-editor.ts`",
  }],
  ["src/lib/use-stored-documents.ts::url", { forwards: "useStoredDocuments", reason: "the hook's own `api()`" }],
  ["src/app/shipping/new/NewShipment.tsx::path", { forwards: "read", reason: "the reader handed to new-shipment-recovery" }],
  ["src/app/customers/[id]/page.tsx::path", { forwards: "call", reason: "the de-duplicating wrapper's own `api()`" }],
]);

type Site = { file: string; line: number; url: string; method: string };

type Scan = { json: Site[]; unclassified: string[]; opaque: Map<string, Site>; derived: Map<string, Set<string>> };

/** One file's share of the census: its JSON request sites, its unclassified `/api/` calls, its
 *  unreadable `api()` URLs, and the `/api/` literals it hands to a JSX attribute or object property. */
function scanFile(file: string, src: string, into: Scan): void {
  const sf = parse(file, src);
  const consts = urlConstants(sf);
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      const url = foldUrl(n.arguments[0], consts);
      const site = { file, line: lineOf(n), url: url ?? "", method: methodOf(n.arguments[1]) };
      if (url !== null && url.startsWith("/api/")) {
        if (callee === "api" || JSON_WRAPPERS.has(callee)) into.json.push(site);
        else if (!RAW_READERS.has(callee) && !NOT_REQUESTS.has(`${file}::${callee}`)) {
          into.unclassified.push(`${file}:${site.line} ${callee}(${url})`);
        }
      } else if (callee === "api") {
        into.opaque.set(`${file}::${n.arguments[0]?.getText(sf) ?? ""}`, site);
      }
    }
    if (ts.isJsxAttribute(n) && n.initializer) {
      const init = ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer;
      const url = init && ts.isExpression(init) ? foldUrl(init, consts) : null;
      if (url?.startsWith("/api/")) add(into.derived, `jsx-attr:${n.name.getText(sf)}`, url);
    }
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
      const url = foldUrl(n.initializer, consts);
      if (url?.startsWith("/api/")) add(into.derived, `property:${n.name.text}`, url);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);
}
const emptyScan = (): Scan => ({ json: [], unclassified: [], opaque: new Map(), derived: new Map() });

let censusCache: Scan | null = null;
function clientCensus(): Scan {
  if (censusCache) return censusCache;
  const scan = emptyScan();
  for (const file of clientFiles()) scanFile(file, read(file), scan);
  censusCache = scan;
  return scan;
}
function add(map: Map<string, Set<string>>, key: string, value: string): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(value);
}

/** The routes a client URL can denote. `urlMatchesRoute` lets a pure hole match a literal segment
 *  (the archival sweep's safe direction), so `/api/orders/${id}` also matches `/api/orders/export`.
 *  For this sweep that over-match would refuse an `api()` read because a binary export shares its
 *  parent path, so where some matching route has a DYNAMIC segment wherever the URL has a pure hole,
 *  only those routes are kept; a hole with no dynamic alternative still matches every literal. */
function routesFor(url: string, patterns: readonly string[]): string[] {
  const matched = patterns.filter((p) => urlMatchesRoute(url, p));
  const client = url.split(/[?#]/)[0].split("/");
  const exact = matched.filter((p) => p.split("/").every((seg, i) => client[i] !== "*" || seg === DYNAMIC));
  return exact.length > 0 ? exact : matched;
}

// ---------------------------------------------------------------------------------------------
// THE ROUTE HALF: one program, the checker's answer per handler
// ---------------------------------------------------------------------------------------------

/** Synthetic routes for the detector cases, overlaid under the project root. */
const VIRTUAL_DIR = "src/app/api/__answer_body_sweep__";
const DETECTOR_CASES: ReadonlyMap<string, { src: string; refused: boolean }> = new Map([
  ["json-undefined", { refused: true, src: `export const GET = handle(async () => NextResponse.json(undefined));` }],
  ["null-204", { refused: true, src: `export const POST = handle(async () => new NextResponse(null, { status: 204 }));` }],
  ["bare-response", { refused: true, src: `export const POST = handle(async () => new Response(undefined, { status: 200 }));` }],
  ["erased-annotation", { refused: true, src: `async function reply(): Promise<NextResponse> { return NextResponse.json({ ok: true }); }
export const PUT = handle(async () => reply());` }],
  ["maybe-undefined", { refused: true, src: `declare const row: { id: string } | undefined;
export const GET = handle(async () => NextResponse.json(row));` }],
  ["any-body", { refused: true, src: `declare const loose: any;
export const PATCH = handle(async () => NextResponse.json(loose));` }],
  ["unknown-body", { refused: true, src: `declare const opaque: unknown;
export const DELETE = handle(async () => NextResponse.json(opaque));` }],
  ["one-bodyless-branch", { refused: true, src: `declare const flag: boolean;
export const POST = handle(async () => (flag ? NextResponse.json({ ok: true }) : new NextResponse(null, { status: 204 })));` }],
  ["function-declaration", { refused: true, src: `export async function GET() { return NextResponse.json(undefined); }` }],
  ["point-free", { refused: true, src: `async function bodyless() { return new NextResponse(null); }
export const GET = handle(bodyless);` }],
  ["null-body", { refused: false, src: `declare const row: { id: string } | null;
export const GET = handle(async () => NextResponse.json(row));` }],
  ["typed-helper", { refused: false, src: `async function reply(detail: { id: string }) { return NextResponse.json({ detail }); }
export const POST = handle(async () => reply({ id: "x" }));` }],
  ["unknown-inside", { refused: false, src: `declare const draft: { payload: unknown };
export const GET = handle(async () => NextResponse.json(draft));` }],
  ["two-typed-branches", { refused: false, src: `declare const flag: boolean;
export const GET = handle(async () => (flag ? NextResponse.json([1]) : NextResponse.json({ rows: [1], cut: true })));` }],
]);
const virtualPath = (name: string): string => `${ROOT}/${VIRTUAL_DIR}/${name}/route.ts`;
const virtualSource = (body: string): string =>
  `import { NextResponse } from "next/server";\nimport { handle } from "@/server/http";\n${body}\n`;

let programCache: { program: ts.Program; checker: ts.TypeChecker } | null = null;
function program(): { program: ts.Program; checker: ts.TypeChecker } {
  if (programCache) return programCache;
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.json"), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
  });
  if (!parsed) throw new Error("tsconfig.json could not be read");
  const options = { ...parsed.options, incremental: false, noEmit: true };
  const virtual = new Map([...DETECTOR_CASES].map(([name, c]) => [virtualPath(name), virtualSource(c.src)]));
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => virtual.has(f) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, lang, onError, create) => {
    const text = virtual.get(f);
    return text !== undefined ? ts.createSourceFile(f, text, lang, true) : getSourceFile.call(host, f, lang, onError, create);
  };
  const p = ts.createProgram({ rootNames: [...routeFiles().map((f) => join(ROOT, f)), ...virtual.keys()], options, host });
  programCache = { program: p, checker: p.getTypeChecker() };
  return programCache;
}

/** The function each exported HTTP method runs, by method: `handle(fn)`'s argument (an inline
 *  function or a name), an unwrapped function, or an exported function declaration. A method whose
 *  function cannot be read is returned as `null`, and the census fails on it. */
function handlersOf(absFile: string): Map<string, ts.Signature | null> {
  const { program: p, checker } = program();
  const sf = p.getSourceFile(absFile);
  if (!sf) throw new Error(`not in the program: ${absFile}`);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const out = new Map<string, ts.Signature | null>();
  for (let symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
    const name = symbol.getName();
    if (!(HTTP_METHODS as readonly string[]).includes(name)) continue;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol.valueDeclaration;
    let fn: ts.Expression | ts.FunctionDeclaration | undefined;
    if (decl && ts.isFunctionDeclaration(decl)) fn = decl;
    else if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = decl.initializer;
      fn = ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "handle"
        ? init.arguments[0] : init;
    }
    let sig: ts.Signature | null = null;
    if (fn && (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      sig = checker.getSignatureFromDeclaration(fn) ?? null;
    } else if (fn && ts.isIdentifier(fn)) {
      const sigs = checker.getTypeAtLocation(fn).getCallSignatures();
      sig = sigs.length === 1 ? sigs[0] : null;
    }
    out.set(name, sig);
  }
  return out;
}

/** Why this handler can answer 2xx with no readable body, or null when it cannot. */
function bodylessReason(sig: ts.Signature): string | null {
  const { checker } = program();
  const returned = checker.getReturnTypeOfSignature(sig);
  const awaited = checker.getAwaitedType(returned) ?? returned;
  const show = (t: ts.Type): string => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
  for (const member of awaited.isUnion() ? awaited.types : [awaited]) {
    const symbol = member.getSymbol();
    const fromNext = symbol?.declarations?.some((d) => d.getSourceFile().fileName.includes("/node_modules/next/")) ?? false;
    if (symbol?.getName() !== "NextResponse" || !fromNext) return `answers ${show(member)}, not NextResponse<…>`;
    const [body] = checker.getTypeArguments(member as ts.TypeReference);
    if (!body) return `answers ${show(member)} with no body type`;
    for (const b of body.isUnion() ? body.types : [body]) {
      if (b.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
        return `answers ${show(member)}, whose body can be ${show(b)}`;
      }
    }
  }
  return null;
}

/** Routes a reached (file, method) pair to its verdict. Exempt pairs are `BODYLESS_ALLOWED` entries. */
const BODYLESS_ALLOWED: ReadonlyMap<string, string> = new Map();

// ---------------------------------------------------------------------------------------------
// THE CENSUS
// ---------------------------------------------------------------------------------------------

type Reached = { route: string; method: string; via: string };

function reachedHandlers(): { reached: Reached[]; unresolved: string[]; staleOpaque: string[]; unlistedOpaque: string[] } {
  const census = clientCensus();
  const routes = routeFiles();
  const patterns = routes.map(routePattern);
  const fileOf = new Map(routes.map((f) => [routePattern(f), f]));
  const reached: Reached[] = [];
  const unresolved: string[] = [];

  const reach = (url: string, method: string, via: string): void => {
    const hits = routesFor(url, patterns);
    let any = false;
    for (const pattern of hits) {
      const file = fileOf.get(pattern)!;
      const methods = [...handlersOf(join(ROOT, file)).keys()];
      for (const m of method === "UNKNOWN" ? methods : methods.filter((x) => x === method)) {
        reached.push({ route: file, method: m, via });
        any = true;
      }
    }
    if (!any) unresolved.push(`${via} ${method} ${url}`);
  };

  for (const s of census.json) reach(s.url, s.method, `${s.file}:${s.line}`);
  const staleOpaque = [...OPAQUE_API.keys()].filter((k) => !census.opaque.has(k));
  const unlistedOpaque = [...census.opaque.keys()].filter((k) => !OPAQUE_API.has(k));
  for (const [key, site] of census.opaque) {
    const entry = OPAQUE_API.get(key);
    if (!entry || entry.forwards) continue;
    const urls = entry.urls ?? [...(census.derived.get(`${entry.derive!.kind}:${entry.derive!.name}`) ?? [])];
    if (urls.length === 0) unresolved.push(`${key} derives no URL`);
    for (const url of urls) reach(url, site.method, `${site.file}:${site.line}`);
  }
  return { reached, unresolved, staleOpaque, unlistedOpaque };
}

describe("#569 — no route answers an api() caller with a 2xx and no body", () => {
  it("classifies every call that takes an /api/ URL, so a new wrapper is a decision", () => {
    expect(clientCensus().unclassified).toEqual([]);
  });

  it("lists every api() call whose URL it cannot read, and nothing it no longer finds", () => {
    const { staleOpaque, unlistedOpaque } = reachedHandlers();
    expect(unlistedOpaque).toEqual([]);
    expect(staleOpaque).toEqual([]);
    for (const [, entry] of OPAQUE_API) {
      expect(entry.reason.length).toBeGreaterThan(10);
      if (entry.forwards) expect(JSON_WRAPPERS.has(entry.forwards)).toBe(true);
    }
  });

  it("joins every api() call to a route that exports its method", () => {
    expect(reachedHandlers().unresolved).toEqual([]);
  });

  it("finds enough of both halves to be a real census, not a vacuous pass", () => {
    const { reached } = reachedHandlers();
    expect(clientCensus().json.length).toBeGreaterThan(250);
    expect(new Set(reached.map((r) => `${r.method} ${r.route}`)).size).toBeGreaterThan(150);
  });

  it("reads a function off every exported method of every route", () => {
    const unreadable = routeFiles().flatMap((f) =>
      [...handlersOf(join(ROOT, f))].filter(([, sig]) => sig === null).map(([m]) => `${m} ${f}`));
    expect(unreadable).toEqual([]);
  });

  it("type-checks the routes it judges: no module the checker could not resolve", () => {
    const { program: p } = program();
    const missing = routeFiles().flatMap((f) => p.getSemanticDiagnostics(p.getSourceFile(join(ROOT, f)))
      .filter((d) => d.code === 2307 || d.code === 2792)
      .map((d) => `${f}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`));
    expect(missing).toEqual([]);
  });

  it("answers every reached handler through NextResponse<X>, X never undefined, void, any or unknown", () => {
    const refused = new Set<string>();
    for (const r of reachedHandlers().reached) {
      const sig = handlersOf(join(ROOT, r.route)).get(r.method);
      const reason = sig ? bodylessReason(sig) : "no readable function";
      const key = `${r.method} ${r.route}`;
      if (reason && !BODYLESS_ALLOWED.has(key)) refused.add(`${key} ${reason} (reached from ${r.via})`);
    }
    expect([...refused].sort()).toEqual([]);
  });

  it("keeps the exemption list empty", () => {
    expect([...BODYLESS_ALLOWED.keys()]).toEqual([]);
  });
});

describe("#569 — the detectors themselves, on sources written to break them", () => {
  it.each([...DETECTOR_CASES])("%s", (name, c) => {
    const handlers = handlersOf(virtualPath(name));
    expect(handlers.size).toBe(1);
    const [sig] = [...handlers.values()];
    expect(sig).not.toBeNull();
    const reason = bodylessReason(sig!);
    if (c.refused) expect(reason).not.toBeNull();
    else expect(reason).toBeNull();
  });

  it("keeps a hole on a dynamic route rather than a literal sibling, and widens only when it must", () => {
    const patterns = ["/api/orders/{}", "/api/orders/export", "/api/receivables/statements"];
    expect(routesFor("/api/orders/*", patterns)).toEqual(["/api/orders/{}"]);
    expect(routesFor("/api/orders/export", patterns)).toEqual(["/api/orders/{}", "/api/orders/export"]);
    // No matching route is dynamic where this hole is, so every literal it can match stays.
    expect(routesFor("/api/*/statements", patterns)).toEqual(["/api/orders/{}", "/api/receivables/statements"]);
  });

  it("refuses a wrapper it has not been told about, lists an api() URL it cannot read, and derives a prop's URLs", () => {
    const scan = emptyScan();
    scanFile("src/app/candidate.tsx", `
      const a = load("/api/orders");
      const b = api(somePath, { method: "POST" });
      const c = api(\`/api/orders/\${id}\`);
      const d = trackedFetch("/api/orders/1/traveler", { method: "POST" });
      const e = <PasteGrid endpoint="/api/widgets/paste" />;
      const f = { listPath: "/api/widgets" };
    `, scan);
    expect(scan.unclassified).toEqual(["src/app/candidate.tsx:2 load(/api/orders)"]);
    expect([...scan.opaque.entries()].map(([k, v]) => [k, v.method])).toEqual([["src/app/candidate.tsx::somePath", "POST"]]);
    expect(scan.json.map((x) => [x.url, x.method])).toEqual([["/api/orders/*", "GET"]]);
    expect([...scan.derived.get("jsx-attr:endpoint") ?? []]).toEqual(["/api/widgets/paste"]);
    expect([...scan.derived.get("property:listPath") ?? []]).toEqual(["/api/widgets"]);
  });

});
