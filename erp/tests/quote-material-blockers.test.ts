import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { findBlockers } from "@/server/reference-blockers";
import { deleteReference } from "@/server/reference";
import { signInWith } from "./helpers/auth";
import { GET as blockersRoute } from "@/app/api/admin/reference/[kind]/[id]/blockers/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const material = await prisma.material.create({ data: { name: "4140" } });
  const user = await prisma.user.create({
    data: { username: "quoter-mat", passwordHash: "x", displayName: "Quoter" } });
  return { customer, part, material, user };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A raw-prisma quote whose line(s) hold `materialId` — built raw (the process-step-code-blockers
 *  shape) so the registry entry is proven against arbitrary states, including a part-linked line
 *  still holding a material it was given while it was free text. */
async function quoteHolding(f: Fixture, quoteNumber: number, opts: {
  lines?: number; status?: "OPEN" | "CLOSED"; quoteDead?: boolean; lineDead?: boolean;
  partLinked?: boolean;
} = {}) {
  return prisma.quote.create({
    data: {
      quoteNumber, customerId: f.customer.id, quotedById: f.user.id,
      quoteDate: new Date("2026-08-01"), effectiveDate: new Date("2026-08-01"),
      expiryDate: new Date("2026-08-31"),
      status: opts.status ?? "OPEN",
      ...(opts.quoteDead ? { deletedAt: new Date() } : {}),
      lines: { create: Array.from({ length: opts.lines ?? 1 }, (_, i) => ({
        position: i + 1, materialId: f.material.id,
        ...(opts.partLinked ? { partId: f.part.id } : { partNumberText: `FT-${quoteNumber}-${i + 1}` }),
        ...(opts.lineDead ? { deletedAt: new Date() } : {}),
      })) },
    },
  });
}

describe("findBlockers targeting material: quote lines (#541)", () => {
  beforeEach(truncateAll);

  it("a free-text line on an OPEN quote blocks, named the Quote way and listed once per quote; "
    + "deleteReference refuses", async () => {
    const f = await fixture();
    // TWO lines on one quote holding the material — the blocker presented is the QUOTE, once.
    const quote = await quoteHolding(f, 1000, { lines: 2 });

    expect(await findBlockers("material", f.material.id)).toEqual([
      { entityLabel: "Quote", name: "Quote · #1000", id: quote.id, href: `/quotes/${quote.id}` },
    ]);
    await expect(asSystem(() => deleteReference("material", f.material.id)))
      .rejects.toThrow("still in use by 1 record(s)");
    expect((await prisma.material.findFirst({ where: { id: f.material.id } }))!.deletedAt).toBeNull();
  });

  it("a free-text line on a CLOSED quote blocks too (ruling 6: any live quote)", async () => {
    const f = await fixture();
    const quote = await quoteHolding(f, 1001, { status: "CLOSED" });

    expect(await findBlockers("material", f.material.id)).toEqual([
      { entityLabel: "Quote", name: "Quote · #1001", id: quote.id, href: `/quotes/${quote.id}` },
    ]);
    await expect(asSystem(() => deleteReference("material", f.material.id)))
      .rejects.toThrow("still in use by 1 record(s)");
  });

  it("the blockers route lists the quote with its link", async () => {
    const f = await fixture();
    const quote = await quoteHolding(f, 1002);
    const cookie = await signInWith(["admin.view"]);
    const res = await blockersRoute(new Request("http://x", { headers: { cookie } }),
      { params: Promise.resolve({ kind: "material", id: f.material.id }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { entityLabel: "Quote", name: "Quote · #1002", id: quote.id, href: `/quotes/${quote.id}` },
    ]);
  });

  // Each non-blocking state is pinned on its own quote, all at once: a deleted line, a line on a
  // deleted quote (its line left live-looking — the chain walk alone must exclude it), and a
  // part-linked line still holding the material (coordinator's ruling: free-text lines only; the
  // part's own material is what such a line prints).
  it("a deleted line, a line on a deleted quote, or a part-linked line does not block — "
    + "the delete then succeeds", async () => {
    const f = await fixture();
    await quoteHolding(f, 1003, { lineDead: true });
    const quoteDead = await quoteHolding(f, 1004, { quoteDead: true });
    expect((await prisma.quoteLine.findFirst({ where: { quoteId: quoteDead.id } }))!.deletedAt).toBeNull();
    await quoteHolding(f, 1005, { partLinked: true });

    expect(await findBlockers("material", f.material.id)).toEqual([]);
    await asSystem(() => deleteReference("material", f.material.id));
    expect((await prisma.material.findFirst({ where: { id: f.material.id } }))!.deletedAt).not.toBeNull();
  });
});
