import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

// Observe the real preload's publication at the create/write boundary. The
// filesystem calls are real; only their scheduling is made deterministic.
const publishedPath = join(process.env.BOOTSTRAP_PROBE_DIRECTORY, "migration-pid");
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
  const fd = fs.openSync(path, "w");
  let duringWrite;
  try {
    try { duringWrite = fs.readFileSync(publishedPath, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; duringWrite = null; }
    write(fd, data, options);
  } finally { fs.closeSync(fd); }
  // Run after the preload has completed its synchronous setup and publication,
  // without waiting for its deliberate eight-second escape alarm.
  setImmediate(() => {
    const published = fs.readFileSync(publishedPath, "utf8");
    fs.writeSync(1, JSON.stringify({ duringWrite, published, pid: process.pid }));
    process.exit(0);
  });
};
syncBuiltinESMExports();
process.argv.push("prisma/build/index.js");
await import("./bootstrap-block-migration.mjs");
