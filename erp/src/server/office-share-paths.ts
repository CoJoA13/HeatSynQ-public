// The office share's path leaf (#588) — PURE: node:path, node:buffer, the errors.ts leaf and the
// client-safe entry leaf only. No fs, no database, no permissions, so it stays importable from
// anywhere and is testable without a filesystem (the backup-paths.ts precedent).
//
// The threat model is the backup leaf's. The share's mount inside the container (OFFICE_SHARE_DIR)
// and the same folder as the office's PCs show it (OFFICE_SHARE_ROOT, "Z:\" or "\\server\share")
// are deploy values, so "confine them to an allowed root" cannot mean much: the mount IS the root.
// What is not a deploy value is the folder path the office pastes into a customer's Invoice folder
// box and the file name a print is filed under. The protection is that a stored folder path can only
// become a path through officeFolderSegments (it must sit under the root, and every name in it must
// be one a Windows share takes) and the builders below, which join only a name that is not empty,
// "." or ".." and holds no separator or NUL, then check with assertInside that the result is still
// inside. Both deploy values are separately refused a NUL, CR or LF, read before any trim, and the
// mount path a ".." segment, as defence in depth.
import path from "node:path";
import { Buffer } from "node:buffer";
import { HttpError } from "./errors";
import { CUSTOMER_FOLDERS_MARKER, normalizeInvoiceFolder } from "@/lib/invoice-folder-entry";

/** `dir` is the resolved mount path; `root` the canonical office-side root ("Z:\", or
 *  "\\server\share[\…]" with no trailing "\"). */
export type OfficeShare = { dir: string; root: string };

// The index signature lets process.env, which declares neither key, be the default.
type ShareEnv = { OFFICE_SHARE_DIR?: string; OFFICE_SHARE_ROOT?: string; [name: string]: string | undefined };

// NUL, CR and LF: a double-quoted .env value turns "\n" in "\\server\new" into a line feed, so the
// refusal makes a mis-quoted value misconfigured rather than a wrong path. It reads the raw value:
// the trim would take a trailing one away unseen.
const LINE_BREAK_OR_NUL = /[\0\r\n]/;

const DRIVE_ROOT = /^[A-Za-z]:\\$/;

function isUncRoot(root: string): boolean {
  if (!root.startsWith("\\\\")) return false;
  const parts = root.slice(2).split("\\");
  return parts.length >= 2 && parts.every((part) => part !== "");
}

/** Off (`null`) when both values are blank. One without the other, or a malformed value, throws:
 *  the message is for the log and never reaches a screen. */
export function resolveOfficeShare(env: ShareEnv = process.env): OfficeShare | null {
  const dirValue = env.OFFICE_SHARE_DIR ?? "";
  const rootValue = env.OFFICE_SHARE_ROOT ?? "";
  if (LINE_BREAK_OR_NUL.test(dirValue)) {
    throw new HttpError(500, `OFFICE_SHARE_DIR holds a NUL, CR or LF: ${JSON.stringify(dirValue)}`);
  }
  if (LINE_BREAK_OR_NUL.test(rootValue)) {
    throw new HttpError(500, `OFFICE_SHARE_ROOT holds a NUL, CR or LF: ${JSON.stringify(rootValue)}`);
  }
  const dir = dirValue.trim();
  const rawRoot = rootValue.trim();
  if (!dir && !rawRoot) return null;
  if (!dir || !rawRoot) {
    throw new HttpError(
      500,
      `OFFICE_SHARE_DIR and OFFICE_SHARE_ROOT must be set together; only ${dir ? "OFFICE_SHARE_DIR" : "OFFICE_SHARE_ROOT"} is set.`,
    );
  }
  // Check the RAW value: path.resolve() would silently normalise "/mnt/share/../etc" to "/mnt/etc",
  // so a post-resolve check can never see the traversal that was asked for.
  if (dir.split(/[\\/]/).includes("..")) {
    throw new HttpError(500, `OFFICE_SHARE_DIR must not contain ".." segments: ${JSON.stringify(dir)}`);
  }
  const root = normalizeInvoiceFolder(rawRoot);
  if (!DRIVE_ROOT.test(root) && !isUncRoot(root)) {
    throw new HttpError(
      500,
      `OFFICE_SHARE_ROOT must be a drive root such as Z:\\ or a UNC path such as \\\\server\\share: ${JSON.stringify(rawRoot)}`,
    );
  }
  return { dir: path.resolve(dir), root };
}

/** The root as the office sees it, for the save's "not inside the invoice share" sentence. */
export function rootDisplay(root: string): string {
  return root;
}

export type FolderSegments =
  | { ok: true; segments: string[] }
  | { ok: false; reason: "outside" | "share-itself" | "bad-name" };

const REFUSED_CHARACTERS = /[<>:"|?*]/;
const DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
const MAX_NAME_BYTES = 255;

function hasControlCharacter(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

/** A name a Windows share takes. A name ending in a dot is refused, which refuses "." and ".." too;
 *  a device name is refused alone or before a dot ("LPT9.txt"), in any case. */
function isShareName(name: string): boolean {
  return (
    name !== "" &&
    !REFUSED_CHARACTERS.test(name) &&
    !hasControlCharacter(name) &&
    !name.endsWith(".") &&
    !name.endsWith(" ") &&
    !DEVICE_NAMES.has(name.split(".")[0].toUpperCase()) &&
    Buffer.byteLength(name, "utf8") <= MAX_NAME_BYTES
  );
}

/** A pasted folder path as the names under the share's root, or why it cannot be one. `root` is
 *  resolveOfficeShare's canonical root. The root is compared without regard to case, as the share
 *  compares it; the names keep theirs. */
export function officeFolderSegments(pasted: string, root: string): FolderSegments {
  const value = normalizeInvoiceFolder(pasted);
  if (value.toLowerCase() === root.toLowerCase()) return { ok: false, reason: "share-itself" };
  // A drive root already ends in "\"; a UNC root is followed by one, so "\\server\share2" is not
  // under "\\server\share".
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  if (value.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return { ok: false, reason: "outside" };
  }
  const segments = value.slice(prefix.length).split("\\");
  if (!segments.every(isShareName)) return { ok: false, reason: "bad-name" };
  return { ok: true, segments };
}

/** The belt: throws unless `child` is strictly inside `parent`. path.relative resolves both, so a
 *  parent written "/mnt/./share" or "/mnt/share/" compares as "/mnt/share". The absolute arm can
 *  only fire where path is win32 (another drive). */
export function assertInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (
    relative === "" ||
    relative.split(path.sep)[0] === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new HttpError(500, `Refusing a path outside ${JSON.stringify(parent)}: ${JSON.stringify(child)}`);
  }
}

// What the builders refuse before they join. Every segment officeFolderSegments returns passes it;
// it stops a name that did not come from there. Each builder's assertInside is a belt: past this
// check (markerPath joins only the marker's constant name) it can fire only if the check is ever
// loosened, but for folderPath given no segments.
function assertJoinableName(name: string): void {
  if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new HttpError(500, `Not a usable name on the invoice share: ${JSON.stringify(name)}`);
  }
}

export function markerPath(dir: string): string {
  const full = path.join(dir, CUSTOMER_FOLDERS_MARKER);
  assertInside(dir, full);
  return full;
}

/** The ONLY way a customer's folder becomes a path under the mount. */
export function folderPath(dir: string, segments: string[]): string {
  segments.forEach(assertJoinableName);
  const full = path.join(dir, ...segments);
  // No segments at all leaves the mount itself, which this refuses.
  assertInside(dir, full);
  return full;
}

/** A file exactly one level inside `folder`: the name holds no separator. */
export function filedPath(folder: string, fileName: string): string {
  assertJoinableName(fileName);
  const full = path.join(folder, fileName);
  assertInside(folder, full);
  return full;
}

/** The temp partner of a filed file: a dotfile beside it, `.<name>.<suffix>.tmp`, so a half-written
 *  copy never carries the final name. `suffix` is 8 lowercase hex characters. */
export function tempPathFor(finalPath: string, suffix: string): string {
  if (!/^[0-9a-f]{8}$/.test(suffix)) {
    throw new HttpError(500, `A temp file's suffix must be 8 lowercase hex characters: ${JSON.stringify(suffix)}`);
  }
  const name = path.basename(finalPath);
  assertJoinableName(name);
  const folder = path.dirname(finalPath);
  const full = path.join(folder, `.${name}.${suffix}.tmp`);
  assertInside(folder, full);
  return full;
}
