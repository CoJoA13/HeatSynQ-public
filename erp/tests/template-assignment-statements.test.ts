// #675: the template assignment walk reads the parent chain once for every document type it
// resolves, where it used to walk the chain once per type, hop by hop, with a second query for each
// hit's template and one more for an inherited hit's ancestor. Counted per root table from Prisma's
// own query log (the same-request-reads.test.ts harness); a mutation that walks per type again reds
// these pins. What the walk RETURNS is pinned by tests/template-assignments.test.ts.
//
// The log is switched on when a client is constructed, so this file swaps the shared client for one
// built with it on, at the same database; every module this file loads gets that client.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", async () => {
  const { PrismaClient } = await import("../prisma/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  return {
    prisma: new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
      log: [{ emit: "event", level: "query" }],
    }),
  };
});

import { prisma, templateId, truncateAll } from "./helpers/db";
import { resolveAssignmentsForCustomer, resolveTemplateForPrint } from "@/server/template-assignments";

/** Every statement the client has sent, in the order it reported them. */
const sent: string[] = [];
(prisma as unknown as { $on(event: "query", listener: (e: { query: string }) => void): void })
  .$on("query", (e) => sent.push(e.query));

/** The statements `run` sends. One macrotask is left for the log to report the last of them. */
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  sent.length = 0;
  await run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...sent];
}

/** How many SELECTs read each table, as `{ Table: n }`, tables with none left out. */
function selectsByTable(statements: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statements) {
    if (!/^\s*SELECT\b/i.test(s)) continue;
    const t = /\bFROM\s+"public"\."(\w+)"/.exec(s)?.[1];
    if (t === undefined) continue;
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

async function makeCustomer(code: string, parentId: string | null = null): Promise<string> {
  const c = await prisma.customer.create({ data: { code, name: `${code} Co`, parentId } });
  return c.id;
}
async function assign(customerId: string, docType: "TRAVELER" | "SHIPPER", tId: string): Promise<void> {
  await prisma.customerTemplateAssignment.create({ data: { customerId, docType, templateId: tId } });
}

beforeEach(async () => {
  await truncateAll();
});

// DocumentTemplate is two reads in every case: the assignments' templates (relationJoins is off, so
// Prisma sends that query beside the assignments, even as `IN (NULL)` when none matched) and the
// defaults of the types left. Before #675 it was two or three per type.
describe("the customer page's display read walks the chain once for all eight types (#675)", () => {
  it("a top-level customer with nothing assigned: one customer read, one assignments read, the templates and defaults", async () => {
    const id = await makeCustomer("TOP");
    const counts = selectsByTable(await statementsOf(() => resolveAssignmentsForCustomer(id)));
    expect(counts).toEqual({ Customer: 1, CustomerTemplateAssignment: 1, DocumentTemplate: 2 });
  });

  it("a division one level down with nothing assigned: one customer read per hop", async () => {
    const parent = await makeCustomer("PAR");
    const id = await makeCustomer("DIV", parent);
    const counts = selectsByTable(await statementsOf(() => resolveAssignmentsForCustomer(id)));
    expect(counts).toEqual({ Customer: 2, CustomerTemplateAssignment: 1, DocumentTemplate: 2 });
  });

  it("an inherited hit and an own hit read their templates with the assignments, and the ancestor with the chain", async () => {
    const parent = await makeCustomer("PAR");
    const id = await makeCustomer("DIV", parent);
    await assign(parent, "TRAVELER", templateId("TRAVELER"));
    await assign(id, "SHIPPER", templateId("SHIPPER"));
    const statements = await statementsOf(() => resolveAssignmentsForCustomer(id));
    // The two hits' templates come in the one query beside the assignments, the ancestor's code and
    // name with the chain, and the six types left in one defaults read.
    expect(selectsByTable(statements)).toEqual({ Customer: 2, CustomerTemplateAssignment: 1, DocumentTemplate: 2 });
  });
});

describe("a print resolves its one type through the same walk", () => {
  it("a division with nothing assigned: the chain, the assignments, the default and its version", async () => {
    const parent = await makeCustomer("PAR");
    const id = await makeCustomer("DIV", parent);
    const counts = selectsByTable(await statementsOf(() => prisma.$transaction((tx) => resolveTemplateForPrint(tx, "TRAVELER", id))));
    expect(counts).toEqual({ Customer: 2, CustomerTemplateAssignment: 1, DocumentTemplate: 2, DocumentTemplateVersion: 1 });
  });
});
