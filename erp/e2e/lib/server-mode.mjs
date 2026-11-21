import assert from "node:assert/strict";
import { parseEnv } from "node:util";

// Server modes for the E2E harness (#326). Pure, so vitest can pin every rule here.
export const SERVER_MODES = Object.freeze(["production", "dev"]);

export function resolveServerMode(value) {
  if (value === undefined || value === "") return "production";
  assert.ok(SERVER_MODES.includes(value), `E2E_SERVER must be "production" or "dev", received ${JSON.stringify(value)}`);
  return value;
}

// E2E_DEV_WEBPACK=1 runs the dev server under webpack instead of Turbopack (#209, owner ruling
// 2026-09-25): Turbopack `next dev` on 16.3.x exhausted memory during the warm-up, so the nightly
// dev-mode run set it. It no longer does. On 16.4.0 the probe of 2026-10-07 measured the Turbopack
// warm-up completing, and the owner's ruling of 2026-10-08 took the knob out of the nightly
// workflow, whose dev server is Turbopack again (tests/github-nightly.test.ts pins the knob's
// absence there). The knob stays as a local escape hatch for a dev-mode run. Only "1"
// enables it. Any other non-empty value refuses, so a `true` or a `yes` cannot silently leave
// Turbopack on. Setting it outside dev mode also refuses: it would otherwise be ignored, and a
// stray value on the production-mode required check would read as if it changed something.
export function resolveDevBundler(value, serverMode) {
  if (value === undefined || value === "") return "turbopack";
  assert.equal(value, "1", `E2E_DEV_WEBPACK must be "1" when set, received ${JSON.stringify(value)}`);
  assert.equal(serverMode, "dev", `E2E_DEV_WEBPACK applies only to E2E_SERVER=dev, not ${JSON.stringify(serverMode)}`);
  return "webpack";
}

// The dev server's argv after `npx`. `--disable-source-maps` is run.mjs's measured choice (its
// comment block above startServer); `--webpack` is appended only when the knob chose it.
export function devServerArgs(port, bundler) {
  assert.ok(bundler === "turbopack" || bundler === "webpack", `Unknown dev bundler ${JSON.stringify(bundler)}`);
  return ["next", "dev", "-p", String(port), "--disable-source-maps", ...(bundler === "webpack" ? ["--webpack"] : [])];
}

// The Dockerfile's runtime-stage copies that make up the web server, in its order.
// tests/e2e-server-mode.test.ts reads the Dockerfile and fails if the two disagree.
// The Dockerfile's other copies (prisma, prisma.config.ts, node_modules, scripts) serve
// the container's migrate-on-start and health check, not the web server.
export const STANDALONE_COPIES = Object.freeze([
  Object.freeze({ from: ".next/standalone", to: "." }),
  Object.freeze({ from: ".next/static", to: ".next/static" }),
  Object.freeze({ from: "public", to: "public" }),
]);

export function dockerServerCopies(dockerfile) {
  return [...dockerfile.matchAll(/^COPY --from=build \/app\/(\S+?)\/? (\S+)$/gm)]
    .map(([, from, to]) => ({ from, to: to.replace(/^\.\/+/, "").replace(/\/$/, "") || "." }))
    .filter(({ from }) => from.startsWith(".next/") || from === "public");
}

// `next build` copies `.env` into `.next/standalone/`, and the standalone server.js loads it
// itself (`@next/env`'s `loadEnvConfig`) — so parsing it here too is belt-and-braces, not the
// only source. File values first, the process environment over them (Next's own precedence,
// which process values win either way it reaches them), then the harness's fixed overrides.
// One gap: `node:util.parseEnv` (used here) does not expand `${VAR}` references the way
// `@next/env` does, so a `.env` entry that expands one would read differently in this parse than
// in the server's own — no entry does today, but a future one that does would silently diverge
// between the harness's copy of the env and what the server itself resolves.
export function serverEnv(dotenvText, processEnv, overrides) {
  const env = { ...parseEnv(dotenvText) };
  for (const [key, value] of Object.entries(processEnv)) if (value !== undefined) env[key] = value;
  return { ...env, ...overrides };
}
