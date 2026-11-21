// #588: what a pasted Invoice folder becomes before it is checked and stored. The page and the
// server are to apply the same leaf, so the box shows what the server stores.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeInvoiceFolder } from "@/lib/invoice-folder-entry";

const CASES: [string, string, string][] = [
  ["a plain drive path", "Z:\\Customers\\Acme", "Z:\\Customers\\Acme"],
  ["Explorer's Copy as path", '"Z:\\Customers\\Acme"', "Z:\\Customers\\Acme"],
  ["Copy as path of the drive itself", '"Z:\\"', "Z:\\"],
  ["whitespace inside the quotes", '"  Z:\\Customers\\Acme  "', "Z:\\Customers\\Acme"],
  ["whitespace around the quotes", '  "Z:\\Customers\\Acme"\t', "Z:\\Customers\\Acme"],
  ["a quote at one end only", '"Z:\\Customers\\Acme', '"Z:\\Customers\\Acme'],
  ["two pairs of quotes, kept whole", '""Z:\\Acme""', '""Z:\\Acme""'],
  ["a quote inside the pair, kept whole", '"Z:\\A"B"', '"Z:\\A"B"'],
  ["a trailing backslash after a closing quote", '"Z:\\Acme"\\', "Z:\\Acme"],
  ["a trailing slash after a space", "Z:\\Acme /", "Z:\\Acme"],
  ["a trailing backslash after a space and a closing quote", '"Z:\\Acme" \\', "Z:\\Acme"],
  ["a lone quote", '"', '"'],
  ["forward slashes", "Z:/Customers/Acme", "Z:\\Customers\\Acme"],
  ["a trailing backslash", "Z:\\Customers\\Acme\\", "Z:\\Customers\\Acme"],
  ["several trailing backslashes", "Z:\\Customers\\Acme\\\\\\", "Z:\\Customers\\Acme"],
  ["a trailing forward slash", "Z:/Customers/Acme/", "Z:\\Customers\\Acme"],
  ["a bare drive", "Z:", "Z:\\"],
  ["a drive root", "Z:\\", "Z:\\"],
  ["a drive root with a forward slash", "z:/", "z:\\"],
  ["a drive root with doubled backslashes", "Z:\\\\", "Z:\\"],
  ["a UNC path", "\\\\server\\share\\Customers", "\\\\server\\share\\Customers"],
  ["a UNC path's trailing backslash", "\\\\server\\share\\", "\\\\server\\share"],
  ["a UNC path in forward slashes", "//server/share/Customers/", "\\\\server\\share\\Customers"],
  ["an inner doubled backslash", "Z:\\Customers\\\\Acme", "Z:\\Customers\\\\Acme"],
  ["only backslashes", "\\\\", "\\\\"],
  ["one slash", "/", "\\"],
  ["surrounding whitespace", "  Z:\\Customers\\Acme \n", "Z:\\Customers\\Acme"],
  ["blank", "", ""],
  ["whitespace only", "  \t ", ""],
  ["empty quotes", '""', ""],
  ["quoted whitespace", '"   "', ""],
  ["case kept", "z:\\customers\\ACME", "z:\\customers\\ACME"],
];

describe("normalizeInvoiceFolder", () => {
  it.each(CASES)("%s", (_label, raw, normalised) => {
    expect(normalizeInvoiceFolder(raw)).toBe(normalised);
  });

  it.each(CASES)("is idempotent: %s", (_label, raw) => {
    const once = normalizeInvoiceFolder(raw);
    expect(normalizeInvoiceFolder(once)).toBe(once);
  });
});

// The E2E harness and a browser flow import these two leaves under plain node, which strips the
// types and resolves no `@/` name, so each must import nothing and keep to syntax node can strip.
describe("the client leaves under plain node", () => {
  it.each([
    ["src/lib/invoice-folder-entry.ts", "CUSTOMER_FOLDERS_MARKER normalizeInvoiceFolder"],
    ["src/lib/customer-folder-words.ts", [
      "BAD_PATH_NAME", "COPY_WAIT_MS", "FOLDER_FOUND", "FOLDER_NOT_FOUND", "INVOICE_FOLDER_HELP",
      "INVOICE_FOLDER_LABEL", "PRINT_FOLDER_NOT_FOUND", "PRINT_NOT_CONNECTED", "PRINT_NO_FOLDER",
      "PRINT_REFUSED", "PRINT_SKIPPED", "PRINT_TIMED_OUT", "PRINT_WARNING_UNREADABLE", "SAVE_BUSY",
      "SAVE_NOT_CONNECTED", "SAVE_TIMED_OUT", "SHARE_ITSELF", "SHARE_NOT_SET_UP", "notInsideShare",
    ].join(" ")],
  ])("plain node imports %s", (file, names) => {
    const url = pathToFileURL(path.join(process.cwd(), file)).href;
    // The test runner's own node options are not passed on: a loader named there could resolve a name.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const found = execFileSync(process.execPath,
      ["--input-type=module", "--eval", `console.log(Object.keys(await import(${JSON.stringify(url)})).sort().join(" "))`],
      { env, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    expect(found.trim()).toBe(names);
  }, 30_000); // The case starts a second node, so it has a limit of its own.
});
