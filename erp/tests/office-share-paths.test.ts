// #588: the office share's pure path leaf and the folder words. Every refusal is asserted by its
// message, never by its class alone: several branches throw HttpError(500), so a bare
// `toThrow(HttpError)` would stay green with a branch deleted while a neighbour threw instead.
import { describe, expect, it } from "vitest";
import {
  assertInside, filedPath, folderPath, markerPath, officeFolderSegments, resolveOfficeShare, rootDisplay,
  tempPathFor,
} from "@/server/office-share-paths";
import { CUSTOMER_FOLDERS_MARKER } from "@/lib/invoice-folder-entry";
import { HttpError } from "@/server/errors";
import {
  COPY_WAIT_MS, PRINT_TIMED_OUT, SAVE_TIMED_OUT, notInsideShare,
} from "@/lib/customer-folder-words";
import * as folderWords from "@/lib/customer-folder-words";

/** `text` as a regular expression that matches it and nothing else. */
const escape = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const throwsHttp500 = (fn: () => unknown, message: RegExp) => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(500);
  expect((caught as HttpError).message).toMatch(message);
};

describe("resolveOfficeShare", () => {
  // The env object is always passed: the default parameter is process.env, which the worktree's
  // .env could fill.
  it("is off when both values are unset or blank", () => {
    expect(resolveOfficeShare({})).toBeNull();
    expect(resolveOfficeShare({ OFFICE_SHARE_DIR: "", OFFICE_SHARE_ROOT: "" })).toBeNull();
    expect(resolveOfficeShare({ OFFICE_SHARE_DIR: "  ", OFFICE_SHARE_ROOT: "\t" })).toBeNull();
  });

  it("refuses one value without the other, either way", () => {
    const together = /must be set together/;
    throwsHttp500(() => resolveOfficeShare({ OFFICE_SHARE_DIR: "/mnt/share" }), together);
    throwsHttp500(() => resolveOfficeShare({ OFFICE_SHARE_DIR: "/mnt/share", OFFICE_SHARE_ROOT: " " }), together);
    throwsHttp500(() => resolveOfficeShare({ OFFICE_SHARE_ROOT: "Z:\\" }), together);
    throwsHttp500(() => resolveOfficeShare({ OFFICE_SHARE_DIR: "", OFFICE_SHARE_ROOT: "Z:\\" }), together);
  });

  it("refuses a NUL, CR or LF in the mount path", () => {
    for (const dir of ["/mnt/sh\0are", "/mnt/share\0", "/mnt/sh\rare", "/mnt/sh\nare"]) {
      throwsHttp500(
        () => resolveOfficeShare({ OFFICE_SHARE_DIR: dir, OFFICE_SHARE_ROOT: "Z:\\" }),
        /OFFICE_SHARE_DIR holds a NUL, CR or LF/,
      );
    }
  });

  // The trim would take a trailing one away unseen, so the raw value is read.
  it("refuses a trailing LF or CR in either value, read before the trim", () => {
    for (const dir of ["/mnt/share\n", "/mnt/share\r", "/mnt/share\r\n", "\n"]) {
      throwsHttp500(
        () => resolveOfficeShare({ OFFICE_SHARE_DIR: dir, OFFICE_SHARE_ROOT: "Z:\\" }),
        new RegExp(`^OFFICE_SHARE_DIR holds a NUL, CR or LF: ${escape(JSON.stringify(dir))}$`),
      );
    }
    for (const root of ["Z:\\\n", "\\\\server\\share\r", "\\\\server\\share \r\n", "\r"]) {
      throwsHttp500(
        () => resolveOfficeShare({ OFFICE_SHARE_DIR: "/mnt/share", OFFICE_SHARE_ROOT: root }),
        new RegExp(`^OFFICE_SHARE_ROOT holds a NUL, CR or LF: ${escape(JSON.stringify(root))}$`),
      );
    }
  });

  it("refuses a .. segment in the RAW mount path (path.resolve would normalise it away)", () => {
    for (const dir of ["/mnt/share/../etc", "../share", "/mnt/share/..", "/mnt\\..\\etc"]) {
      throwsHttp500(
        () => resolveOfficeShare({ OFFICE_SHARE_DIR: dir, OFFICE_SHARE_ROOT: "Z:\\" }),
        /OFFICE_SHARE_DIR must not contain "\.\." segments/,
      );
    }
    // A name that only starts with two dots is not a .. segment.
    expect(resolveOfficeShare({ OFFICE_SHARE_DIR: "/mnt/..share", OFFICE_SHARE_ROOT: "Z:\\" }))
      .toEqual({ dir: "/mnt/..share", root: "Z:\\" });
  });

  it("refuses a NUL, CR or LF in the root, as a double-quoted .env value delivers it", () => {
    // dotenv and @next/env both read OFFICE_SHARE_ROOT="\\server\new" as \\server, a line feed, ew.
    for (const root of ["\\\\server\new", "\\\\server\\sh\rare", "Z:\\\0"]) {
      throwsHttp500(
        () => resolveOfficeShare({ OFFICE_SHARE_DIR: "/mnt/share", OFFICE_SHARE_ROOT: root }),
        /OFFICE_SHARE_ROOT holds a NUL, CR or LF/,
      );
    }
  });

  it("refuses a root that is neither a drive root nor a UNC share", () => {
    for (const root of [
      "Z", "ZZ:\\", "1:\\", "Customers\\X", "Z:\\Customers", "Z:Customers", "\\\\server", "\\\\server\\",
      "\\\\\\server\\share", "\\\\server\\\\share", "\\\\server\\share\\\\Customers", "\\server\\share",
    ]) {
      throwsHttp500(
        () => resolveOfficeShare({ OFFICE_SHARE_DIR: "/mnt/share", OFFICE_SHARE_ROOT: root }),
        /OFFICE_SHARE_ROOT must be a drive root/,
      );
    }
  });

  it("takes a drive root in any spelling, canonical as X:\\", () => {
    for (const [raw, root] of [
      ["Z:\\", "Z:\\"], ["Z:", "Z:\\"], ["Z:/", "Z:\\"], ["Z:\\\\", "Z:\\"], ["  Z:\\  ", "Z:\\"],
      ['"Z:\\"', "Z:\\"], ["z:\\", "z:\\"],
    ]) {
      expect(resolveOfficeShare({ OFFICE_SHARE_DIR: "/mnt/share", OFFICE_SHARE_ROOT: raw }), raw)
        .toEqual({ dir: "/mnt/share", root });
    }
  });

  it("takes a UNC root with server and share, optionally deeper, with no trailing backslash", () => {
    for (const [raw, root] of [
      ["\\\\server\\share", "\\\\server\\share"],
      ["\\\\server\\share\\", "\\\\server\\share"],
      ["//server/share/Customers/", "\\\\server\\share\\Customers"],
    ]) {
      expect(resolveOfficeShare({ OFFICE_SHARE_DIR: "/mnt/share", OFFICE_SHARE_ROOT: raw }), raw)
        .toEqual({ dir: "/mnt/share", root });
    }
  });

  it("resolves a relative mount path and trims both values", () => {
    expect(resolveOfficeShare({ OFFICE_SHARE_DIR: " ./share ", OFFICE_SHARE_ROOT: "Z:\\" }))
      .toEqual({ dir: `${process.cwd()}/share`, root: "Z:\\" });
  });
});

describe("rootDisplay", () => {
  it("shows the root as the office sees it", () => {
    expect(rootDisplay("Z:\\")).toBe("Z:\\");
    expect(rootDisplay("\\\\server\\share")).toBe("\\\\server\\share");
  });
});

describe("officeFolderSegments", () => {
  const DRIVE = "Z:\\";
  const UNC = "\\\\server\\share";
  const ok = (segments: string[]) => ({ ok: true, segments });
  const refused = (reason: string) => ({ ok: false, reason });

  it("maps a path under a drive root to its segments, keeping their case", () => {
    expect(officeFolderSegments("Z:\\Customers\\Acme Steel", DRIVE)).toEqual(ok(["Customers", "Acme Steel"]));
    expect(officeFolderSegments("Z:\\ACME", DRIVE)).toEqual(ok(["ACME"]));
  });

  it("maps a path under a UNC root, a deeper one included", () => {
    expect(officeFolderSegments("\\\\server\\share\\Customers\\Acme", UNC)).toEqual(ok(["Customers", "Acme"]));
    expect(officeFolderSegments("\\\\server\\share\\Customers\\Acme", "\\\\server\\share\\Customers"))
      .toEqual(ok(["Acme"]));
  });

  it("compares the root without regard to case", () => {
    expect(officeFolderSegments("z:\\customers\\Acme", DRIVE)).toEqual(ok(["customers", "Acme"]));
    expect(officeFolderSegments("Z:\\Acme", "z:\\")).toEqual(ok(["Acme"]));
    expect(officeFolderSegments("\\\\SERVER\\Share\\Acme", UNC)).toEqual(ok(["Acme"]));
  });

  it("normalises the pasted path first: quotes, slashes, a trailing backslash", () => {
    expect(officeFolderSegments('"Z:\\Customers\\Acme"', DRIVE)).toEqual(ok(["Customers", "Acme"]));
    expect(officeFolderSegments("Z:/Customers/Acme/", DRIVE)).toEqual(ok(["Customers", "Acme"]));
  });

  it("refuses the share itself", () => {
    for (const pasted of ["Z:\\", "Z:", "z:/", '"Z:\\"']) {
      expect(officeFolderSegments(pasted, DRIVE), pasted).toEqual(refused("share-itself"));
    }
    for (const pasted of ["\\\\server\\share", "\\\\server\\share\\", "\\\\SERVER\\SHARE"]) {
      expect(officeFolderSegments(pasted, UNC), pasted).toEqual(refused("share-itself"));
    }
  });

  it("refuses a path outside the root", () => {
    for (const pasted of ["Y:\\Customers\\Acme", "Customers\\Acme", "\\\\server\\share\\Acme", ""]) {
      expect(officeFolderSegments(pasted, DRIVE), pasted).toEqual(refused("outside"));
    }
    // The root must be followed by a backslash: a share whose name only starts with the root's is
    // another share.
    for (const pasted of ["\\\\server\\share2\\Acme", "\\\\server\\shareAcme", "\\\\server\\sha", "\\\\other\\share\\Acme", "Z:\\Acme"]) {
      expect(officeFolderSegments(pasted, UNC), pasted).toEqual(refused("outside"));
    }
    expect(officeFolderSegments("\\\\server\\share\\Other\\Acme", "\\\\server\\share\\Customers"))
      .toEqual(refused("outside"));
  });

  it("refuses an empty segment", () => {
    for (const pasted of ["Z:\\A\\\\B", "Z:\\\\A"]) {
      expect(officeFolderSegments(pasted, DRIVE), pasted).toEqual(refused("bad-name"));
    }
    expect(officeFolderSegments("\\\\server\\share\\\\A", UNC)).toEqual(refused("bad-name"));
  });

  it("refuses each character a Windows share does not allow", () => {
    for (const c of ["<", ">", ":", '"', "|", "?", "*"]) {
      expect(officeFolderSegments(`Z:\\Customers\\A${c}B`, DRIVE), c).toEqual(refused("bad-name"));
    }
  });

  it("refuses a control character, U+0000 to U+001F", () => {
    for (const c of ["\u0000", "\u0001", "\t", "\u001f"]) {
      expect(officeFolderSegments(`Z:\\Customers\\A${c}B`, DRIVE), JSON.stringify(c)).toEqual(refused("bad-name"));
    }
    expect(officeFolderSegments("Z:\\Customers\\A\u0020B", DRIVE)).toEqual(ok(["Customers", "A B"]));
  });

  it("refuses a name ending in a dot or a space, which refuses . and .. too", () => {
    for (const pasted of [
      "Z:\\Customers\\Acme.", "Z:\\Customers.\\Acme", "Z:\\Acme \\B", "Z:\\.\\Acme", "Z:\\Customers\\..\\Acme",
      "Z:\\Customers\\..",
    ]) {
      expect(officeFolderSegments(pasted, DRIVE), pasted).toEqual(refused("bad-name"));
    }
    // A leading dot, or two, is a name.
    expect(officeFolderSegments("Z:\\.hidden\\..Acme", DRIVE)).toEqual(ok([".hidden", "..Acme"]));
  });

  it("refuses a Windows device name, alone or before a dot, in any case", () => {
    for (const name of ["CON", "con", "PRN", "AUX", "NUL", "Com3", "COM1", "COM9", "LPT1", "LPT9.txt", "nul.tar.gz", "Aux.Acme"]) {
      expect(officeFolderSegments(`Z:\\Customers\\${name}`, DRIVE), name).toEqual(refused("bad-name"));
    }
    for (const name of ["CONSOLE", "COM10", "COM0", "LPT", "NULL", "xCON", "CON2", "Acme.CON"]) {
      expect(officeFolderSegments(`Z:\\Customers\\${name}`, DRIVE), name).toEqual(ok(["Customers", name]));
    }
  });

  it("refuses a name over 255 bytes in UTF-8, counted in bytes, not characters", () => {
    const fits = `${"é".repeat(127)}a`; // 255 bytes, 128 characters
    const over = "é".repeat(128); // 256 bytes, 128 characters
    expect(officeFolderSegments(`Z:\\${fits}`, DRIVE)).toEqual(ok([fits]));
    expect(officeFolderSegments(`Z:\\${over}`, DRIVE)).toEqual(refused("bad-name"));
    expect(officeFolderSegments(`Z:\\${"a".repeat(255)}`, DRIVE)).toEqual(ok(["a".repeat(255)]));
    expect(officeFolderSegments(`Z:\\${"a".repeat(256)}`, DRIVE)).toEqual(refused("bad-name"));
  });
});

describe("assertInside (the belt)", () => {
  const outside = /Refusing a path outside/;

  it("passes a child strictly inside, the parent written any way", () => {
    for (const [parent, child] of [
      ["/tmp/a", "/tmp/a/b"], ["/tmp/a", "/tmp/a/b/c"], ["/tmp/a/./b", "/tmp/a/b/c"], ["/tmp/a/", "/tmp/a/b"],
      ["/tmp/a", "/tmp/a/..foo"],
    ]) {
      expect(() => assertInside(parent, child), `${parent} ${child}`).not.toThrow();
    }
  });

  it("refuses the parent itself, a sibling, the parent's parent, a .. escape and another absolute path", () => {
    for (const [parent, child] of [
      ["/tmp/a", "/tmp/a"], ["/tmp/a/", "/tmp/a"], ["/tmp/a/./b", "/tmp/a/b"], ["/tmp/a", "/tmp/ab"],
      ["/tmp/a", "/tmp/b"], ["/tmp/a", "/tmp"], ["/tmp/a", "/tmp/a/../b"], ["/tmp/a/./b", "/tmp/a/b/.."],
      ["/tmp/a", "/etc/passwd"],
    ]) {
      throwsHttp500(() => assertInside(parent, child), outside);
    }
  });
});

describe("the path builders", () => {
  const badName = /Not a usable name on the invoice share/;
  const BAD = ["", ".", "..", "a/b", "a\\b", "a\0b", "../x"];

  it("puts the marker at the top of the mount", () => {
    expect(CUSTOMER_FOLDERS_MARKER).toBe("HeatSynQ - do not delete.txt");
    expect(markerPath("/mnt/share")).toBe("/mnt/share/HeatSynQ - do not delete.txt");
    expect(markerPath("/mnt/share/")).toBe("/mnt/share/HeatSynQ - do not delete.txt");
  });

  it("builds a customer folder from its segments", () => {
    expect(folderPath("/mnt/share", ["Customers", "Acme Steel"])).toBe("/mnt/share/Customers/Acme Steel");
  });

  it("refuses a folder segment that is empty, . or .., or holds /, \\ or NUL", () => {
    for (const bad of BAD) {
      throwsHttp500(() => folderPath("/mnt/share", ["Customers", bad]), badName);
    }
  });

  it("refuses no segments at all: the mount itself is not a customer folder", () => {
    throwsHttp500(() => folderPath("/mnt/share", []), /Refusing a path outside/);
  });

  it("files a name exactly one level inside the folder", () => {
    expect(filedPath("/mnt/share/Customers/Acme", "Invoice-1001.pdf")).toBe("/mnt/share/Customers/Acme/Invoice-1001.pdf");
  });

  it("refuses a file name that is empty, . or .., or holds /, \\ or NUL", () => {
    for (const bad of BAD) {
      throwsHttp500(() => filedPath("/mnt/share/Customers/Acme", bad), badName);
    }
  });

  it("puts the temp file beside the final one as a dotfile", () => {
    expect(tempPathFor("/mnt/share/Acme/Invoice-1001.pdf", "0a1b2c3d"))
      .toBe("/mnt/share/Acme/.Invoice-1001.pdf.0a1b2c3d.tmp");
  });

  it("refuses a temp suffix that is not exactly 8 lowercase hex characters", () => {
    for (const suffix of ["", "0a1b2c3", "0a1b2c3d4", "0A1B2C3D", "0a1b2c3g", "../../x", "0a1b2c3d\n", "0a1b/c3d"]) {
      throwsHttp500(() => tempPathFor("/mnt/share/Acme/Invoice-1001.pdf", suffix), /8 lowercase hex characters/);
    }
  });

  it("refuses a final path whose name is empty, . or .., or holds \\ or NUL", () => {
    for (const final of ["/", "/mnt/share/.", "/mnt/share/..", "/mnt/share/a\\b", "/mnt/share/a\0b"]) {
      throwsHttp500(() => tempPathFor(final, "0a1b2c3d"), badName);
    }
  });
});

describe("the folder words", () => {
  it("states the copy's wait in both 10-second sentences", () => {
    expect(COPY_WAIT_MS).toBe(10_000);
    expect(SAVE_TIMED_OUT).toContain(`${COPY_WAIT_MS / 1000} seconds`);
    expect(PRINT_TIMED_OUT).toContain(`${COPY_WAIT_MS / 1000} seconds`);
  });

  // Typed from the plan's Amendments 8 and 9 (the owner's words, 2026-10-20), never copied from the
  // module: every word must read exactly so, and a word added to the module must be added here.
  it("holds every word exactly as the owner ruled it", () => {
    expect({ ...folderWords, notInsideShare: folderWords.notInsideShare("Z:\\") }).toEqual({
      INVOICE_FOLDER_LABEL: "Invoice folder",
      INVOICE_FOLDER_HELP: "Paste the folder's path from Windows Explorer's address bar. Leave it blank to file nothing.",
      FOLDER_FOUND: "Folder found.",
      SHARE_NOT_SET_UP: "This install has no invoice share set up, so an invoice folder cannot be saved.",
      notInsideShare: "That path is not inside the invoice share, Z:\\. Paste a folder's path from Windows Explorer's address bar.",
      SHARE_ITSELF: "That is the share itself. Paste the customer's own folder inside it.",
      BAD_PATH_NAME: "That path holds a name or character a Windows share does not allow.",
      FOLDER_NOT_FOUND: "No folder was found at that path. Check it in Windows Explorer, then paste it again.",
      SAVE_NOT_CONNECTED: "The invoice share is not connected, so the folder could not be checked. Save it again once it is reconnected.",
      SAVE_TIMED_OUT: "The invoice share did not answer within 10 seconds, so the folder could not be checked. Save it again.",
      SAVE_BUSY: "The invoice share is busy with an earlier copy, so the folder could not be checked. Save it again in a few minutes.",
      PRINT_NO_FOLDER: "Not filed in a customer folder \u2014 no invoice folder is set for this customer.",
      PRINT_FOLDER_NOT_FOUND: "Not filed in the customer folder \u2014 the customer's invoice folder was not found. Check it on the customer page.",
      PRINT_NOT_CONNECTED: "Not filed in the customer folder \u2014 the shared folder is not connected. Print again once it is reconnected.",
      PRINT_TIMED_OUT: "Not filed in the customer folder \u2014 the shared folder did not finish the copy within 10 seconds. Print again to file it.",
      PRINT_SKIPPED: "Not filed in the customer folder \u2014 an earlier copy is still waiting on the shared folder. Print again in a few minutes to file it.",
      PRINT_REFUSED: "Not filed in the customer folder \u2014 the shared folder refused the copy. Print again; if it fails again, check the share.",
      PRINT_WARNING_UNREADABLE: "The print reported a folder problem that could not be read \u2014 check the customer folder.",
      COPY_WAIT_MS: 10_000,
    });
  });

  it("names the install's own root when a path is not inside it", () => {
    expect(notInsideShare("Z:\\")).toBe(
      "That path is not inside the invoice share, Z:\\. Paste a folder's path from Windows Explorer's address bar.",
    );
    expect(notInsideShare("\\\\server\\share")).toBe(
      "That path is not inside the invoice share, \\\\server\\share. Paste a folder's path from Windows Explorer's address bar.",
    );
  });
});
