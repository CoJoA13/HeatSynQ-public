import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function readImageDecoder(appDir) {
  const appRequire = createRequire(path.join(appDir, "package.json"));
  // Match Next's require('sharp'), including a nested installation. Loading the module
  // verifies the native binary; package.json alone cannot establish the linked libheif.
  const nextRequire = createRequire(appRequire.resolve("next/dist/server/image-optimizer.js"));
  return nextRequire("sharp").versions;
}

export function assertPatchedImageDecoder(versions) {
  const version = versions?.heif;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Image decoder requires a valid stable libheif version");
  }
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger) || parts[0] < 1 ||
      (parts[0] === 1 && (parts[1] < 23 || (parts[1] === 23 && parts[2] < 2)))) {
    throw new Error(`Image decoder libheif ${version} is below the approved patched minimum 1.23.2`);
  }
}

// CI streams this same self-contained file into the built image: no dind bind mount and
// no host dependency resolution. This guard is a CI check, not a production startup hook.
if (process.argv[1] === "-" || (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)) {
  try {
    const decoder = readImageDecoder(process.cwd());
    console.log(JSON.stringify({ platform: process.platform, decoder }, null, 2));
    if (process.platform !== "linux") throw new Error("Image decoder check requires the approved Linux image");
    assertPatchedImageDecoder(decoder);
    console.log("Image decoder policy: PASS");
  } catch (error) {
    console.error(`Image decoder policy: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
