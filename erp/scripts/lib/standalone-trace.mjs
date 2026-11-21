// What `next build` may put in `.next/standalone` — a pure, dependency-free leaf (#334).
//
// One dynamic filesystem call the tracer cannot narrow makes Next trace the whole project into the
// standalone output: tests, the E2E suite and its artifacts, the Compose file, the lot. The build
// only warns. The manual backup's `pg_dump` spawn did that until #334 marked it with the tracer's
// opt-out comment, which a reformat or a refactor can drop without any gate noticing. So the
// required `ci` check lists the output after the build and refuses anything this file does not
// expect.
//
// Expected: Next's own server (`server.js`, `package.json`, `.next/`), the traced `node_modules/`,
// the vendored font directory that `outputFileTracingIncludes` names whole (render.ts reads the
// fonts from `process.cwd()` at run time), and the two env files Next copies by design
// (`writeStandaloneDirectory` copies `.env` and `.env.production` when the build loaded them; the
// Docker build context has neither, by `.dockerignore`). The public source adds the files its
// startup admission reads from `process.cwd()`, which `outputFileTracingIncludes` names: the public
// migration manifest, the baseline's template configurations and the migration directory.
//
// The fonts are checked both ways. A file under `src/` that is not a vendored font is whole-project
// tracing again, and a vendored font missing from the output is a traveler that cannot render.
//
// It lives in its own file because the script that walks the directories exits the process; this
// half takes the two listings and returns problems. Keep it pure: no fs, no process.

export const FONT_DIRECTORY = "src/server/pdf/fonts/";
const TOP_LEVEL_FILES = new Set(["server.js", "package.json"]);
const TOP_LEVEL_DIRECTORIES = [".next/", "node_modules/"];
const ENV_FILES = new Set([".env", ".env.production"]);
const PUBLIC_PRISMA_FILES = new Set(["prisma/public-migrations.json", "prisma/public-baseline-templates.json"]);
const PUBLIC_MIGRATION_DIRECTORY = "prisma/migrations/";

/** Whether one path of the standalone output, relative to it and with forward slashes, is expected. */
export function expected(file) {
  return TOP_LEVEL_FILES.has(file)
    || ENV_FILES.has(file)
    || PUBLIC_PRISMA_FILES.has(file)
    || file.startsWith(PUBLIC_MIGRATION_DIRECTORY)
    || TOP_LEVEL_DIRECTORIES.some((directory) => file.startsWith(directory))
    || file.startsWith(FONT_DIRECTORY);
}

/**
 * The problems with a standalone output: one line each, none when it is as expected.
 *
 * `standaloneFiles` lists every file under `.next/standalone`, relative to it. `sourceFonts` lists
 * every file under the checkout's font directory, relative to the app root. Both use forward slashes.
 */
export function traceProblems(standaloneFiles, sourceFonts) {
  const problems = [];
  const present = new Set(standaloneFiles);
  for (const required of ["server.js", ...sourceFonts]) {
    if (!present.has(required)) problems.push(`missing from the standalone output: ${required}`);
  }
  if (sourceFonts.length === 0) problems.push(`no vendored font found under ${FONT_DIRECTORY}`);
  const unexpected = standaloneFiles.filter((file) => !expected(file)).sort();
  // The whole project is thousands of files; name where they are, not each one.
  const roots = new Map();
  for (const file of unexpected) {
    const root = file.includes("/") ? `${file.slice(0, file.indexOf("/"))}/` : file;
    roots.set(root, (roots.get(root) ?? 0) + 1);
  }
  for (const [root, count] of roots) {
    problems.push(`not expected in the standalone output: ${root}${root.endsWith("/") ? ` (${count} file${count === 1 ? "" : "s"})` : ""}`);
  }
  return problems;
}
