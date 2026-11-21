import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { truncateAll, prisma } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { holdFile, statusFile } from "@/server/update-paths";
import type { UpdateStatus } from "@/lib/release-contracts";
import { GET } from "@/app/api/updates/route";
import { POST as HOLD } from "@/app/api/updates/hold/route";
import { POST as SEEN } from "@/app/api/updates/seen/route";

const ctx = { params: Promise.resolve({}) };
const T = "2026-11-01T12:00:00Z";
const note = (version: string) => ({ version, publishedAt: T, databaseChanges: false, body: `notes ${version}` });
const status: UpdateStatus = {
  schemaVersion: 1, writtenAt: T, running: { version: "1.3.0", at: T },
  pending: { version: "1.4.0", publishedAt: T, firstSeenAt: T, databaseChanges: true, installAfter: T, state: "scheduled", reason: null },
  notes: [note("1.1.0"), note("1.2.0"), note("1.3.0"), note("1.4.0")],
};

let dir: string;
let saved: string | undefined;
beforeEach(async () => {
  await truncateAll();
  saved = process.env.UPDATES_DIR;
  dir = mkdtempSync(path.join(tmpdir(), "updates-routes-"));
  process.env.UPDATES_DIR = dir;
  writeFileSync(statusFile(dir), JSON.stringify(status));
});
afterEach(() => {
  if (saved === undefined) delete process.env.UPDATES_DIR; else process.env.UPDATES_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
  vi.doUnmock("@/server/practice-mode");
  vi.resetModules();
});

const get = (cookie: string) => GET(new Request("http://t/api/updates", { headers: { cookie } }), ctx);
const post = (h: typeof HOLD, cookie: string, body: unknown) =>
  h(new Request("http://t/api/updates", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  }), ctx);

describe("GET /api/updates", () => {
  it("gives a user without admin.view no pending, hold or canHold; null last seen shows the running release only", async () => {
    const cookie = await signInWith([]);
    const res = await get(cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBe("1.3.0");
    expect(body.whatsNew.map((n: { version: string }) => n.version)).toEqual(["1.3.0"]);
    expect(body.pending).toBeNull();
    expect(body.pendingNote).toBeNull();
    expect(body.hold).toBeNull();
    expect(body.canHold).toBe(false);
  });

  it("is 401 when signed out", async () => {
    expect((await GET(new Request("http://t/api/updates"), ctx)).status).toBe(401);
  });

  it("gives admin.view the pending release and the hold, and admin.edit canHold", async () => {
    const viewer = await (await get(await signInWith(["admin.view"], "viewer"))).json();
    expect(viewer.pending.version).toBe("1.4.0");
    expect(viewer.pendingNote).toEqual(note("1.4.0"));
    expect(viewer.hold).toEqual({ held: false, fromVersion: null, by: null, at: null });
    expect(viewer.canHold).toBe(false);
    const editor = await (await get(await signInWith(["admin.view", "admin.edit"], "editor"))).json();
    expect(editor.canHold).toBe(true);
  });

  describe("the hold file repair", () => {
    async function holdInDb(username: string) {
      const user = await prisma.user.findFirstOrThrow({ where: { username } });
      await prisma.updateHold.update({
        where: { id: "singleton" },
        data: { held: true, fromVersion: "1.4.0", heldById: user.id, heldAt: new Date("2026-11-02T10:00:00Z") },
      });
    }
    it("an admin.view read rewrites an absent or garbage hold.json as held", async () => {
      const cookie = await signInWith(["admin.view"], "viewer");
      await holdInDb("viewer");
      await get(cookie);
      expect(JSON.parse(readFileSync(holdFile(dir), "utf8"))).toMatchObject({ held: true, fromVersion: "1.4.0", by: "viewer" });
      writeFileSync(holdFile(dir), "garbage");
      await get(cookie);
      expect(JSON.parse(readFileSync(holdFile(dir), "utf8")).held).toBe(true);
    });
    it("a caller without admin.view leaves the file untouched", async () => {
      const cookie = await signInWith([], "plain");
      await holdInDb("plain");
      await get(cookie);
      expect(existsSync(holdFile(dir))).toBe(false);
      writeFileSync(holdFile(dir), "garbage");
      await get(cookie);
      expect(readFileSync(holdFile(dir), "utf8")).toBe("garbage");
    });
  });

  it("answers running null and no notes with no UPDATES_DIR", async () => {
    delete process.env.UPDATES_DIR;
    const body = await (await get(await signInWith(["admin.view"]))).json();
    expect(body.running).toBeNull();
    expect(body.whatsNew).toEqual([]);
    expect(body.pending).toBeNull();
  });

  it("reads nothing on the practice database", async () => {
    vi.doMock("@/server/practice-mode", () => ({ practiceMode: async () => true }));
    vi.resetModules();
    const { GET: practiceGet } = await import("@/app/api/updates/route");
    const cookie = await signInWith(["admin.view", "admin.edit"]);
    const res = await practiceGet(new Request("http://t/api/updates", { headers: { cookie } }), ctx);
    expect(await res.json()).toEqual({ running: null, whatsNew: [], pending: null, pendingNote: null, hold: null, canHold: false });
  });
});

describe("POST /api/updates/hold", () => {
  it("is 403 without admin.edit", async () => {
    const res = await post(HOLD, await signInWith(["admin.view"]), { held: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty("error");
  });

  it("holds with admin.edit and answers the view", async () => {
    const res = await post(HOLD, await signInWith(["admin.view", "admin.edit"]), { held: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ held: true, fromVersion: "1.4.0" });
  });

  it("refuses a malformed body", async () => {
    const res = await post(HOLD, await signInWith(["admin.edit"]), { held: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/updates/seen", () => {
  it("stores the version on the caller's own row", async () => {
    const cookie = await signInWith([]);
    const res = await post(SEEN, cookie, { version: "1.3.0" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lastSeenVersion: "1.3.0" });
    expect((await prisma.user.findFirstOrThrow({ where: { username: "root" } })).lastSeenVersion).toBe("1.3.0");
  });

  it("is 400 for 1.4", async () => {
    const res = await post(SEEN, await signInWith([]), { version: "1.4" });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });
});
