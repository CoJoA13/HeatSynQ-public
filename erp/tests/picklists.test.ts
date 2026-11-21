import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { createReference, deleteReference, updateReference } from "@/server/reference";
import { createStepCode } from "@/server/process-step-codes";
import { GET } from "@/app/api/picklists/[kind]/route";
import { listPickList } from "@/server/picklists";
import { signInWith } from "./helpers/auth";

const ctx = (kind: string) => ({ params: Promise.resolve({ kind }) });

describe("pick-list route", () => {
  beforeEach(async () => await truncateAll());

  it("401s without a session", async () => {
    const res = await GET(new Request("http://x/api/picklists/material"), ctx("material"));
    expect(res.status).toBe(401);
  });

  it("serves a kind to a user holding NO area permissions", async () => {
    // The whole point: a user with customers.edit but not admin.view must still see Terms.
    // Nothing to grant means nothing to forget.
    await createReference("material", { name: "4140" });
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/material", { headers: { cookie } }),
                          ctx("material"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: expect.any(String), name: "4140", active: true }]);
  });

  it("serves process step codes without leaking their GL account", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    await createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: gl.id });
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/processStepCode", { headers: { cookie } }),
                          ctx("processStepCode"));
    const [row] = await res.json();
    expect(row).toEqual({ id: expect.any(String), name: expect.stringContaining("HT-01"), active: true });
    expect(row).not.toHaveProperty("glAccountId");
  });

  // Phase 6 (spec §5.15): quote entry reads ending statements with a session, like every other
  // entry pick-list. The generic delegate branch serves it — id/name/active only, never `text`
  // or `isDefault` (the quote service resolves the default row itself, server-side).
  it("serves ending statements to any signed-in user", async () => {
    await createReference("endingStatement", { name: "Standard", text: "Valid 30 days.", isDefault: true });
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/endingStatement", { headers: { cookie } }),
                          ctx("endingStatement"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: expect.any(String), name: "Standard", active: true }]);
  });

  // Weights design §9.4 (2026-10-09): both order screens prefill a container row's Tare each from
  // the type, so this read carries a container type's default tare each: a number, or null for a
  // type with none. It is the one kind that carries more than id, name and active. The material,
  // step code and ending statement cases above hold those three kinds to exactly the three keys.
  // The other kinds are served by the one select material and ending statements go through, and
  // have no case of their own.
  it("serves a container type's default tare each as a number, null for none, to any signed-in user", async () => {
    // Created out of name order, so the order asserted below is the query's and not the inserts'.
    await createReference("containerType", { name: "Wire Basket" });
    await createReference("containerType", { name: "Steel Basket", tareEach: "42.50" });
    await createReference("containerType", { name: "Pallet", tareEach: "0" });
    const retired = await createReference("containerType", { name: "Old Crate", tareEach: "75.25" });
    await updateReference("containerType", retired.id, { active: false });
    const gone = await createReference("containerType", { name: "Gone", tareEach: "10" });
    await deleteReference("containerType", gone.id);

    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/containerType", { headers: { cookie } }),
                          ctx("containerType"));
    expect(res.status).toBe(200);
    // Live, active types only. 0 is a figure and null is none: they are not the same answer.
    expect(await res.json()).toEqual([
      { id: expect.any(String), name: "Pallet", active: true, tareEach: 0 },
      { id: expect.any(String), name: "Steel Basket", active: true, tareEach: 42.5 },
      { id: expect.any(String), name: "Wire Basket", active: true, tareEach: null },
    ]);

    // includeInactive=1 brings back the inactive type with its figure, and never the deleted one.
    const all = await GET(new Request("http://x/api/picklists/containerType?includeInactive=1", { headers: { cookie } }),
                          ctx("containerType"));
    expect((await all.json()).map((r: { name: string; tareEach: number | null }) => [r.name, r.tareEach])).toEqual([
      ["Old Crate", 75.25], ["Pallet", 0], ["Steel Basket", 42.5], ["Wire Basket", null],
    ]);

    // A caller that names the kind is typed with the figure, as a number, with no cast.
    const typed = await listPickList("containerType");
    expect(typed.map((r) => r.tareEach)).toEqual([0, 42.5, null]);
  });

  it("404s glAccount — it stays admin-only", async () => {
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/glAccount", { headers: { cookie } }),
                          ctx("glAccount"));
    expect(res.status).toBe(404);
  });

  it("404s an unknown kind", async () => {
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/nope", { headers: { cookie } }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("excludes soft-deleted rows and, by default, inactive ones", async () => {
    const live = await createReference("carrier", { name: "UPS" });
    const dead = await createReference("carrier", { name: "Gone" });
    await deleteReference("carrier", dead.id);
    const off = await createReference("carrier", { name: "Retired" });
    await updateReference("carrier", off.id, { active: false });

    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/carrier", { headers: { cookie } }), ctx("carrier"));
    expect((await res.json()).map((r: { id: string }) => r.id)).toEqual([live.id]);

    // includeInactive=1 brings back the inactive row but never the deleted one — an assigned
    // inactive value must still render, which is the inactive-vs-deleted distinction.
    const res2 = await GET(new Request("http://x/api/picklists/carrier?includeInactive=1", { headers: { cookie } }),
                           ctx("carrier"));
    const ids = (await res2.json()).map((r: { id: string }) => r.id);
    expect(ids).toContain(off.id);
    expect(ids).not.toContain(dead.id);
  });
});
