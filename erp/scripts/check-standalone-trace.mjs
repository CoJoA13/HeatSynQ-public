// Refuses a `next build` whose standalone output carries more than the server (#334).
// Run after `npm run build`. The rule and its reasons are in lib/standalone-trace.mjs. It checks
// the app this file belongs to; its suite passes another app root as the one argument.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_DIRECTORY, traceProblems } from "./lib/standalone-trace.mjs";

const ERP_ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

/**
 * Every file under `directory`, relative to `base`, with forward slashes. A symlink is listed, and
 * Node's recursive readdir also walks one that points at a directory, so that target's files are
 * listed under the link's path and judged there.
 */
function files(directory, base) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(base, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

const standalone = path.join(ERP_ROOT, ".next", "standalone");
let problems;
try {
  problems = traceProblems(files(standalone, standalone), files(path.join(ERP_ROOT, FONT_DIRECTORY), ERP_ROOT));
} catch (error) {
  problems = [`could not list the standalone output (run 'npm run build' first): ${error.message}`];
}
if (problems.length > 0) {
  console.error("ERROR: .next/standalone is not the server alone (#334).");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("A dynamic filesystem call is probably tracing the whole project: read the build's own warning.");
  process.exit(1);
}
console.log("The standalone output holds the server, its node_modules, the PDF font directory and any env file Next copied; nothing else.");
