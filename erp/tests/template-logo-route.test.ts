import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { TINY_JPEG } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createTemplate, uploadLogo, deleteTemplate } from "@/server/templates";
import { GET as logoRoute } from "@/app/api/templates/[id]/logo/route";

/** GET /api/templates/[id]/logo — the draft's logo bytes for the canvas designer's <img>. */

const FIXTURE_LOGO = readFileSync(new URL("../e2e/fixtures/logo.png", import.meta.url));

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const getReq = (url: string, cookie?: string) =>
  new Request(url, { headers: cookie ? { cookie } : {} });

describe("GET /api/templates/[id]/logo", () => {
  let viewer: string;
  let bare: string;
  let tmpl: string;

  beforeEach(async () => {
    await truncateAll();
    viewer = await signInWith(["templates.view"], "logo-viewer");
    bare = await signInWith([], "logo-bare");
    tmpl = (await asSystem(() => createTemplate("TRAVELER", "Logo Route"))).id;
  });

  const call = (id: string, cookie?: string) =>
    logoRoute(getReq(`http://t/api/templates/${id}/logo`, cookie), withParams({ id }));

  it("401 anonymous", async () => {
    expect((await call(tmpl)).status).toBe(401);
  });

  it("403 for a session without templates.view", async () => {
    expect((await call(tmpl, bare)).status).toBe(403);
  });

  it("404 Template not found for an unknown id", async () => {
    const res = await call("00000000-0000-4000-8000-000000000000", viewer);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Template not found");
  });

  it("404 No logo image for a draft with no logo", async () => {
    const res = await call(tmpl, viewer);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No logo image");
  });

  it("200 with the uploaded bytes, the stored mime and no-store", async () => {
    await asSystem(() => uploadLogo(tmpl, FIXTURE_LOGO, "image/png"));
    const res = await call(tmpl, viewer);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(FIXTURE_LOGO)).toBe(true);
  });

  it("404 Template not found once the template is soft-deleted", async () => {
    await asSystem(() => uploadLogo(tmpl, FIXTURE_LOGO, "image/png"));
    await asSystem(() => deleteTemplate(tmpl, "retired"));
    const res = await call(tmpl, viewer);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Template not found");
  });

  it("answers the stored mime, not a fixed one (JPEG)", async () => {
    await asSystem(() => uploadLogo(tmpl, Buffer.from(TINY_JPEG), "image/jpeg"));
    const res = await call(tmpl, viewer);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(TINY_JPEG))).toBe(true);
  });
});
