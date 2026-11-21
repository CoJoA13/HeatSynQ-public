// Static sweeps over the flow sources (#167a fix round). `failure-classify.mjs` answers "may this
// RED run become a green one?"; this file answers the opposite and nastier question:
//
//     can this GREEN run be green while the thing it asserts is broken?
//
// Both shapes below were found in code that had just been reviewed, and both produce a PASS rather
// than a failure — which is why neither can be left to a census by hand. Nothing here does IO; the
// caller reads the files and owns the refusal (the `findRawApiMutations` precedent, and the same
// two enforcement points: `run.mjs` before flow 1, and a sweep in `tests/e2e-harness.test.ts` so
// CI sees it without running the suite).
//
// Both detectors deliberately OVER-match and fail CLOSED, `issuesMutatingRequest`'s rule: a sweep a
// comment can talk its way past is a sweep a real call can talk its way past too. The escape hatch
// is the sanctioned helper, never a comment.

/** The statement a hit sits in: from the hit to the next `;`, capped so a missing semicolon cannot
 *  swallow the rest of the file. Chained locator statements routinely span three or four lines, so
 *  a line-at-a-time scan would miss the half that matters. */
function statementAt(source, index) {
  const end = source.indexOf(";", index);
  const stop = end === -1 ? source.length : end + 1;
  return source.slice(index, Math.min(stop, index + 600));
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function snippetOf(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  let lineEnd = source.indexOf("\n", index);
  if (lineEnd === -1) lineEnd = source.length;
  return source.slice(lineStart, lineEnd).trim();
}

// A row locator taken straight off `page` — no section, no table, no scope of any kind.
const PAGE_ROW_LOCATOR = /\bpage\s*\.\s*(?:locator\(\s*["'](?:table\s+)?(?:tbody\s+)?tr\b|getByRole\(\s*["']row["'])/g;
// ...filtered by an ORDER NUMBER. That combination is the board-row family and nothing else: the
// board is the one screen whose rows are keyed by order number and whose OTHER columns (PO, Qty,
// Weight, Loads, VS #) print bare numbers of their own.
const ORDER_NUMBER_TOKEN = /\borderNumber\b|\border\s*\.\s*number\b|\bcreated\s*\.\s*orderNumber\b/;

/**
 * Row locators built on `page` and filtered by an order number — the shape that went red for real
 * on 2026-08-22 (`ship-partial-then-complete`'s order weighs exactly 1200 lb, so its Weight cell
 * collided with order #1200's number cell) and that then survived a whole review round in
 * `void-order.mjs`, where it sat inside an `assert.rejects` and so would have PASSED while the
 * voided row was still on screen. `boardRow` (`e2e/lib/orders.mjs`) is the sanctioned shape: it
 * matches the order-number CELL, resolved from the table header.
 *
 * What it deliberately does NOT flag, so the refusal stays actionable:
 *   * a row locator scoped to a section or a table (`sectionByHeading(...).locator("tr")`,
 *     `receivables.locator("tbody tr")`) — the /invoicing and /receivables family, whose collision
 *     surface is far narrower and which #167a recorded as found-not-fixed rather than fixing;
 *   * a bare `page.locator("tr")` filtered by something that is not an order number (a surcharge
 *     kind, a payment-type name) — no other column prints those.
 */
export function findAmbientRowLocators(source) {
  const found = [];
  for (const m of source.matchAll(PAGE_ROW_LOCATOR)) {
    const statement = statementAt(source, m.index);
    if (!ORDER_NUMBER_TOKEN.test(statement)) continue;
    found.push({ line: lineOf(source, m.index), snippet: snippetOf(source, m.index) });
  }
  return found;
}

const ASSERT_REJECTS = /\bassert\s*\.\s*rejects\s*\(/g;

/**
 * `assert.rejects(someLocator.waitFor(...), "it should not be there")` — an absence assertion that
 * passes on ANY rejection, including Playwright's strict-mode violation. Two matching elements make
 * the locator throw, the promise rejects, and the assertion reports SUCCESS — while the element it
 * swears is absent is on screen twice. A green run proving nothing, which is worse than a red one.
 *
 * `assertNeverVisible` (`e2e/lib/ui.mjs`) is the sanctioned shape: it requires the rejection to be
 * the TIMEOUT, and turns a strict-mode violation into a named failure.
 *
 * `assert.rejects` around anything else (an API call that must 403, a service that must throw) is
 * untouched — it is only the `waitFor` pairing that can launder a strict-mode violation into a
 * pass, because "no such element" and "several such elements" both reject there.
 */
export function findUncheckedAbsenceAssertions(source) {
  const found = [];
  for (const m of source.matchAll(ASSERT_REJECTS)) {
    const statement = statementAt(source, m.index);
    if (!/\.\s*waitFor\s*\(/.test(statement)) continue;
    found.push({ line: lineOf(source, m.index), snippet: snippetOf(source, m.index) });
  }
  return found;
}

// A code-less Error minted as a flow FAILURE (#193). The third false-green shape, and the subtlest:
// `classifyFailure` opens with a hard override that an `ERR_ASSERTION` failure is NEVER a network one,
// precisely so a stale netFailure earlier in a flow cannot launder a real assertion failure into
// `FAIL [network]` and — in a flow that mutated nothing — into a granted retry and a green run. A
// plain `Error` carries no `ERR_ASSERTION` code, so it walks straight through that override. Convert
// each to `assert.ok`/`assert.match`/`assert.fail`, or — where the failure is delivered through a
// promise — `reject(new assert.AssertionError({ message }))`; the message text is good, keep it, and
// the `AssertionError` is what the override covers. The hand-rolled timeout throws
// (`if (Date.now() > deadline) ...`) are the sharpest case: they are the shape most likely to fire on
// a slow or contended machine, i.e. the same machine most likely to carry a stale netFailure.
//
// TWO delivery verbs are covered — `throw` and a promise `reject(...)` (Codex P2, round 2: a dialog
// handler that `reject(new Error(...))`s reaches classifyFailure with the identical code-less Error a
// `throw` would). `new` is OPTIONAL and the constructor may be QUALIFIED (`throw Error(...)`,
// `throw new globalThis.Error(...)`, `reject(new errors.TimeoutError(...))`), because every one of
// those mints a code-less error. `AssertionError` is EXCLUDED (the `(?<!Assertion)Error` lookbehind):
// it carries `ERR_ASSERTION`, which is the whole point, so the sanctioned fix is not flagged. A
// re-raise of a caught error (`throw err`, `reject(err)`) is NOT matched — it preserves the original
// classification (`assertNeverVisible` does exactly this for a transport error), which is correct.
// `throwError(...)` (no space after `throw`) is a function call, not a throw statement, and stays out.
// A parenthesized delivery — `throw (new Error(...))`, `reject((new TypeError(...)))` — is covered by
// the leading `\(*\s*` (Codex round 3, P2); like the mutation sweep, a determined dynamic obfuscation
// (a code-less error routed through a helper or a computed constructor) is out of scope for a text
// scan, the `assert.*` / `reject(new assert.AssertionError(...))` escape hatch being the real guard.
const CODELESS_ERROR = String.raw`\(*\s*(?:new\s+)?(?:[\w$]+\s*\.\s*)*\w*(?<!Assertion)Error\s*\(`;
const PLAIN_ERROR_FAILURE = new RegExp(String.raw`\bthrow\s+${CODELESS_ERROR}|\breject\s*\(\s*${CODELESS_ERROR}`, "g");

/**
 * Every code-less-Error flow failure (`throw`n or `reject`ed) in one suite source, with 1-based line
 * numbers. Pure: the caller reads the file and raises the refusal.
 */
export function findPlainErrorFailures(source) {
  const found = [];
  for (const m of source.matchAll(PLAIN_ERROR_FAILURE)) {
    found.push({ line: lineOf(source, m.index), snippet: snippetOf(source, m.index) });
  }
  return found;
}

// --- 4. A route registered or removed without the keep-alive (#342) -------------------------------
//
// Playwright intercepts every request of a page while the page has any route, and turns
// interception off when the last one is removed; a request the page issues in that instant never
// settles (#340). `routeRequests` (e2e/route-keep-alive.mjs) gives a page a second route that is
// never removed, and hands back the function that removes the flow's own. A route registered
// straight on the page has no such company, and one removed straight off it may be the last.
//
// Refused: a routing method CALLED on any receiver, in dot, optional-chain or bracket form; one
// reached through bind, call or apply; a member of that name assigned whole to a name
// (`= a.b.route;`); and an object pattern naming one on the left of `=`. The receiver is not
// checked, on purpose: a page reaches a helper under any name, and a context's routes carry the
// same hazard. The last two arms over-match on purpose: a DATA field of that name that is assigned
// or destructured that way is refused too, and reads the field where it is used instead. A field
// that is only read in place (the warm-up's results have one) is not matched, nor is a handler's
// own parameter, which has no dot before it. It fails closed like its siblings: the escape hatch is
// the helper, never a comment. Like them it is a text scan, so a method passed on as an argument,
// kept in an object, chosen by a conditional or named by a computed key is out of its reach.
const ROUTING_METHOD = String.raw`(?:route|unroute|unrouteAll|routeFromHAR|routeWebSocket)`;
const RAW_ROUTE_CALL = new RegExp(
  String.raw`\.\s*${ROUTING_METHOD}\s*\(` +
  String.raw`|\.\s*${ROUTING_METHOD}\s*\.\s*(?:bind|call|apply)\b` +
  String.raw`|\[\s*["'\x60]${ROUTING_METHOD}["'\x60]\s*\]` +
  String.raw`|=\s*\(*\s*(?:await\s+)?[\w$]+\s*\)*(?:\s*(?:\??\.\s*[\w$]+|\[[^\]\n]*\]|\([^()\n]*\)))*\s*\??\.\s*${ROUTING_METHOD}\s*\)*\s*(?:[;,]|\/\/|\/\*|$)` +
  String.raw`|\{[^{}]*\b${ROUTING_METHOD}\b[^{}]*\}\s*=(?!=)`,
  "gm",
);

/**
 * Every routing-method use in one suite source, with 1-based line numbers. Pure: the caller reads
 * the file and raises the refusal.
 */
export function findRawRouteCalls(source) {
  const found = [];
  for (const m of source.matchAll(RAW_ROUTE_CALL)) {
    found.push({ line: lineOf(source, m.index), snippet: snippetOf(source, m.index) });
  }
  return found;
}

// #843. A read through the page's request context rides a pooled keep-alive socket that Node's
// server closes after 6 s idle, and a reuse landing within milliseconds of that close resets
// (`e2e/api-mutate.mjs` has the measurement). `api-mutate.mjs` closes that race for writes with
// its warming GET; a read closes it for itself with `{ maxRetries: 1 }`, under which Playwright
// replays a reset socket once (ECONNRESET only), which replays nothing a read did not already do.
// `close-month-end` read the preliminary report bare after seconds of waits and went red with
// `socket hang up` on #842, in a flow that had mutated and so could not be retried (#843, owner
// ruling 2026-11-01). The method name, the context reached by dot or bracket and the method by
// dot or bracket, whose OWN argument list does not carry `maxRetries: 1` as a top-level property
// of one of its arguments: the list alone, never the statement around it (a second read's option
// in the same statement covers nothing but its own call), and the option itself, never the same
// text nested in `params` or `headers` or handed to a call (Codex on #846, three rounds). Fail-closed
// like the rest: a bound or aliased method, a reference with no argument list and a quoted call in
// a docstring are hits too, so a swept source describes the call in prose. Writes are
// `findRawApiMutations`'s and are not read here.
const REQUEST_GET = /\brequest(?:["'\x60]\s*\])?\s*(?:\.\s*get\b|\[\s*["'\x60]get["'\x60]\s*\])/g;
// The whole value: the literal 1, then the next property, the close or a comment, so `1 - 1`, `10`
// or `1 ? 2 : 3` is not it (Codex on #846, sixth round).
const ONE_RETRY = /^maxRetries\s*:\s*1\s*(?:[,}]|\/\/|\/\*)/;

/**
 * Walks `source` from `start` to `stop` and calls `visit(index, char)` for each character of
 * top-level CODE: not inside a quoted string, not in a template literal's text, not in a
 * template's `${…}` interpolation (code again, but another expression's: a URL's literal `)`
 * neither closes a list early nor extends it into the next call, and an option named inside an
 * interpolation is not the call's), and not in a line or block comment (an option commented out
 * supplies no retry at runtime: Codex on #846, fourth round). The contexts nest: an interpolation
 * may hold a template, which may hold an interpolation. It does not read regex literals (telling
 * `/` from division takes a tokenizer): a `)` inside one closes a list early, so a protected read
 * written that way is reported bare, never the reverse, and the escape is a const before the call
 * (ruled a limitation at Codex's sixth round on #846). Returns the index `visit` stopped at (by
 * returning true), or `stop`.
 */
function walkCode(source, start, stop, visit) {
  // The stack of open contexts above the top-level code: a quote character, "template" for a
  // template literal's text, "//" or "/*" for a comment, or a brace depth (a number) for an
  // interpolation's code.
  const stack = [];
  for (let j = start; j < stop; j += 1) {
    const c = source[j];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      if (c === "\\") j += 1;
      else if (c === top) stack.pop();
    } else if (top === "template") {
      if (c === "\\") j += 1;
      else if (c === "\x60") stack.pop();
      else if (c === "$" && source[j + 1] === "{") { stack.push(0); j += 1; }
    } else if (top === "//") {
      if (c === "\n") stack.pop();
    } else if (top === "/*") {
      if (c === "*" && source[j + 1] === "/") { stack.pop(); j += 1; }
    } else if (c === "/" && source[j + 1] === "/") { stack.push("//"); j += 1; }
    else if (c === "/" && source[j + 1] === "*") { stack.push("/*"); j += 1; }
    else if (c === '"' || c === "'") stack.push(c);
    else if (c === "\x60") stack.push("template");
    else if (typeof top === "number" && c === "{") stack[stack.length - 1] = top + 1;
    else if (typeof top === "number" && c === "}") { if (top === 0) stack.pop(); else stack[stack.length - 1] = top - 1; }
    else if (top === undefined && visit(j, c)) return j;
  }
  return stop;
}

/** The matched method's own argument list, `(` to its matching `)`, capped like `statementAt`;
 *  "" where no list follows (a bound or aliased method). */
function ownArguments(source, end) {
  let i = end;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== "(") return "";
  let depth = 0;
  const close = walkCode(source, i, Math.min(source.length, i + 600), (_, c) => {
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    return depth === 0;
  });
  return source.slice(i, close + 1);
}

/** Whether an argument list carries `maxRetries: 1` as a top-level property of an object literal
 *  that is itself an argument: the `{` right after the list's `,` at the list's own paren depth,
 *  so an object inside an expression (`cond ? { … } : {}`, `a || { … }`, a call's argument) is not
 *  it (Codex on #846, eighth round), nor the same text in `params: { … }`, in `[ … ]` or nested
 *  deeper; the whole property name, so `mymaxRetries: 1` is not it either (fifth round); and the
 *  last word at that level, as the runtime's: a later `...spread` or a later `maxRetries` of
 *  another value overrides it, and only an explicit `maxRetries: 1` after those restores it
 *  (seventh round). A quoted key (`"maxRetries": 1`) sits in a string and is not read: write the
 *  key bare. */
const RETRY_KEY = /^maxRetries\s*:/;
function asksOneRetry(args) {
  let paren = 0, brace = 0, bracket = 0, asks = false, prev = "", literal = false;
  walkCode(args, 0, args.length, (j, c) => {
    if (c === "{" && paren === 1 && brace === 0 && bracket === 0) literal = prev === ",";
    if (c === "(") paren += 1; else if (c === ")") paren -= 1;
    else if (c === "{") brace += 1; else if (c === "}") brace -= 1;
    else if (c === "[") bracket += 1; else if (c === "]") bracket -= 1;
    else if (literal && paren === 1 && brace === 1 && bracket === 0) {
      if (c === "m" && !/[\w$]/.test(args[j - 1] ?? "") && RETRY_KEY.test(args.slice(j, j + 24))) {
        asks = ONE_RETRY.test(args.slice(j, j + 48));
      } else if (c === "." && args.startsWith("...", j)) asks = false;
    }
    if (!/\s/.test(c)) prev = c;
    return false;
  });
  return asks;
}

/**
 * Every read through the request context that does not ask for one retry of a reset socket, in
 * one suite source, with 1-based line numbers. Pure: the caller reads the file and raises the
 * refusal.
 */
export function findBareReads(source) {
  const found = [];
  for (const m of source.matchAll(REQUEST_GET)) {
    if (asksOneRetry(ownArguments(source, m.index + m[0].length))) continue;
    found.push({ line: lineOf(source, m.index), snippet: snippetOf(source, m.index) });
  }
  return found;
}
