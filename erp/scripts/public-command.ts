import "dotenv/config";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "../prisma/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { publicDatabaseUrl } from "./lib/public-client";
import { assertPublicInstallation, publicCommandRefusalLine } from "./lib/public-installation";
import { loadPublicMigrations } from "./lib/public-migrations";

const root = resolve(process.cwd());
const [command, ...args] = process.argv.slice(2);
// No arbitrary subprocess, Prisma reset flag or config/URL override can escape admission.
const supported = new Set(["deploy", "migrate", "seed", "demo", "reset", "dev", "start", "container", "check"]);
async function child(entry: string, argv: string[]): Promise<void> {
  await new Promise<void>((ok, fail) => {
    const running = spawn(process.execPath, [resolve(root, entry), ...argv], {
      cwd: root, env: process.env, stdio: "inherit",
    });
    const forward = (signal: NodeJS.Signals) => { running.kill(signal); };
    const onTerm = () => forward("SIGTERM"); const onInt = () => forward("SIGINT");
    process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
    const cleanup = () => { process.off("SIGTERM", onTerm); process.off("SIGINT", onInt); };
    running.once("error", () => { cleanup(); fail(new Error("Public child command failed to start")); });
    running.once("exit", (code, signal) => {
      cleanup();
      if (code === 0 && !signal) ok();
      else fail(new Error("Public child command failed"));
    });
  });
}
async function main(): Promise<void> {
  if (!supported.has(command)) throw new Error("Unknown public command");
  if (args.length && !(command === "reset" && args.length === 1 && args[0] === "--yes")) {
    throw new Error("Unsupported public command arguments");
  }
  const url = publicDatabaseUrl();
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const expected = await loadPublicMigrations(resolve(root, "prisma"));
    await assertPublicInstallation(db, expected, { allowPending: ["deploy", "migrate", "container"].includes(command) });
    // Public migrate applies the reviewed immutable successor manifest. Schema development and
    // authoring new public migrations is a maintainer review workflow, never a reset-capable CLI.
    if (["deploy", "migrate", "container"].includes(command)) {
      await child("node_modules/prisma/build/index.js", ["migrate", "deploy"]);
      await assertPublicInstallation(db, await loadPublicMigrations(resolve(root, "prisma")));
    }
  } finally { await db.$disconnect(); }
  if (command === "dev") await child("node_modules/next/dist/bin/next", ["dev"]);
  if (command === "start") await child("node_modules/next/dist/bin/next", ["start"]);
  if (command === "container") await child("server.js", []);
  if (command === "seed") await child("scripts/public-runtime/seed.mjs", []);
  if (command === "demo") await child("scripts/public-runtime/demo-seed.mjs", []);
  if (command === "reset") await child("scripts/public-runtime/db-reset.mjs", args);
}
main().catch((error: unknown) => {
  console.error(publicCommandRefusalLine(error));
  process.exitCode = 1;
});
