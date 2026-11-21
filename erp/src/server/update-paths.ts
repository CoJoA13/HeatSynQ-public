// The update-folder path leaf — PURE (node:path and the errors leaf only; no fs, no database), the
// backup-paths.ts shape. UPDATES_DIR is a deploy value the host's update agent shares with the app
// container (`./updates` mounted at `/updates`). Unset or blank means "this install has no update
// folder" (a dev machine, the practice copy): null, never a default path.
import path from "node:path";
import { HttpError } from "./errors";

export const UPDATE_STATUS_FILENAME = "status.json";
export const UPDATE_HOLD_FILENAME = "hold.json";

const UNSAFE_CHARS = /[\0\n\r`$;&|<>*?()[\]{}'"\\]/;

export function resolveUpdatesDir(raw: string | undefined = process.env.UPDATES_DIR): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (UNSAFE_CHARS.test(value)) {
    throw new HttpError(500, `The update folder path contains unsafe characters: ${JSON.stringify(value)}`);
  }
  // The RAW value: path.resolve() would normalise "/updates/../etc" to "/etc" before any check.
  if (value.split(/[\\/]/).includes("..")) {
    throw new HttpError(500, `The update folder path must not contain ".." segments: ${value}`);
  }
  // /*turbopackIgnore: true*/ below: the folder is a runtime value; see updates.ts (#334).
  return path.resolve(/*turbopackIgnore: true*/ value);
}

export function statusFile(dir: string): string {
  return path.join(/*turbopackIgnore: true*/ dir, UPDATE_STATUS_FILENAME);
}

export function holdFile(dir: string): string {
  return path.join(/*turbopackIgnore: true*/ dir, UPDATE_HOLD_FILENAME);
}
