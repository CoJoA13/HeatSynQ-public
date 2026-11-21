import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Preloaded by the real CLI and its descendants. Only the actual Prisma
// migration process is held; the production CLI reaches its real DB lock/spawn.
if (process.argv.some(argument => argument.endsWith("prisma/build/index.js"))) {
  process.on("SIGTERM", () => {}); // exercise bounded escalation, not just TERM
  // Independent of fixture cancellation: mutation must fail visibly without
  // leaving an immortal child behind when the command-owner guard is removed.
  setTimeout(() => {
    writeFileSync(join(process.env.BOOTSTRAP_PROBE_DIRECTORY, "migration-escaped"), "escaped");
    process.exit(99);
  }, 8_000);
  // Publish readiness only once the handler and complete PID are in place. A
  // polling parent must never observe the empty create-before-write window.
  const pidPath = join(process.env.BOOTSTRAP_PROBE_DIRECTORY, "migration-pid");
  writeFileSync(`${pidPath}.tmp`, String(process.pid));
  renameSync(`${pidPath}.tmp`, pidPath);
  await new Promise(() => { setInterval(() => {}, 1_000); });
}
