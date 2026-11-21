// What a process document save sends to the database (#658, G1-2). Counted from Prisma's own query
// log, as `tests/order-read-statements.test.ts` does, because a relational `deleteMany` or a nested
// create can be more than one statement and no delegate counter would see it.
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

import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { readProcessDocument, saveProcessDocument } from "@/server/process-document";
import { lockRevision } from "@/server/part-process-steps";
import type { ProcessDraftStep } from "@/lib/process-document";

const asSystem = <T>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const sent: string[] = [];
(prisma as unknown as { $on(event: "query", listener: (e: { query: string }) => void): void })
  .$on("query", (e) => sent.push(e.query));
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  sent.length = 0;
  await run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...sent];
}
/** `KIND Table` for a write, the statement's first table named after its verb. */
const write = (s: string) => {
  const m = /^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+"public"\."(\w+)"/.exec(s) ?? /^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+"(\w+)"/.exec(s);
  return m ? `${m[1].split(" ")[0]} ${m[2]}` : null;
};
const tx = (s: string) => /^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i.test(s);

/** A part of `steps` steps with `rows` TEXT rows each, over four codes, saved through the one path. */
async function fixture(steps = 20, rows = 5) {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P1", eachWeight: 1 } });
  const codes = await Promise.all([1, 2, 3, 4].map(n => prisma.processStepCode.create({ data: { code: `C${n}`, name: `Code ${n}` } })));
  const empty = await readProcessDocument(part.id);
  await asSystem(() => saveProcessDocument(part.id, { expectedBaselineToken: empty.baselineToken, steps: Array.from({ length: steps }, (_, i) => {
    const code = codes[i % codes.length];
    return { clientId: `new:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, stepId: null, codeId: code.id, codeSeen: { code: code.code, name: code.name },
      instruction: `Step ${i + 1}`, parameters: Array.from({ length: rows }, (_, r) => ({ key: `new:00000000-0000-4000-9000-${String(i * 100 + r).padStart(12, "0")}`, label: `Row ${r + 1}`, type: "TEXT" as const, unit: null, value: `v${r}` })) };
  }) }));
  return { part, codes };
}
async function draft(partId: string) {
  const baseline = await readProcessDocument(partId);
  return { expectedBaselineToken: baseline.baselineToken, steps: (baseline.revision?.steps ?? []).map<ProcessDraftStep>(s => ({
    clientId: s.id, stepId: s.id, codeId: s.codeId, instruction: s.instruction,
    parameters: s.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value })),
  })) };
}

/** The statements a save sends, transaction control left out. */
async function saveStatements(partId: string, input: Awaited<ReturnType<typeof draft>>) {
  return (await statementsOf(() => asSystem(() => saveProcessDocument(partId, input)))).filter(st => !tx(st));
}
const writes = (statements: string[]) => statements.flatMap(st => write(st) ?? []);
const stepTreeReads = (statements: string[]) => statements.filter(st => /^\s*SELECT\b[\s\S]*\bFROM\s+"public"\."PartProcessStep"\s/.test(st)).length;
const CLAIMS = ["UPDATE Part", "UPDATE ProcessStepCode", "UPDATE ProcessStepCode", "UPDATE ProcessStepCode", "UPDATE ProcessStepCode"];

// Measured before the change (2026-11-03): 121 statements for the one-instruction edit below, 183
// when the save cut a revision. Every kept step was parked and updated and every step's rows were
// deleted and inserted again, and the step tree was read seven times.
describe("a process document save's statements (#658)", () => {
  beforeEach(truncateAll);
  it("one edited instruction on 20 steps of 5 rows writes that one step and nothing else", async () => {
    const { part } = await fixture();
    const input = await draft(part.id); input.steps[7].instruction = "Edited";
    const statements = await saveStatements(part.id, input);
    expect(writes(statements)).toEqual([...CLAIMS, "UPDATE PartProcessStep", "INSERT AuditLog"]);
    // The claim's read, the audit's two snapshots and the answer's projection: the opening
    // projection takes the claim's read instead of its own.
    expect(stepTreeReads(statements)).toBe(4);
    expect(statements).toHaveLength(37);
  });
  it("the same edit on a locked revision copies the steps and their rows in one statement each", async () => {
    const { part } = await fixture();
    await prisma.$transaction(t => lockRevision(part.id, 1, t));
    const input = await draft(part.id); input.steps[7].instruction = "Edited";
    const statements = await saveStatements(part.id, input);
    expect(writes(statements)).toEqual([...CLAIMS, "INSERT PartProcessRevision", "INSERT AuditLog",
      "INSERT PartProcessStep", "INSERT PartProcessStepParameter", "UPDATE PartProcessStep", "INSERT AuditLog"]);
    expect(statements).toHaveLength(41);
  });
  it("a step inserted first parks and renumbers every kept step, then inserts the new step and its rows", async () => {
    const { part, codes } = await fixture(3, 2);
    const input = await draft(part.id);
    const added = { clientId: "new:00000000-0000-4000-8000-00000000abcd", stepId: null, codeId: codes[0].id, codeSeen: { code: codes[0].code, name: codes[0].name },
      instruction: "First", parameters: [{ key: "new:00000000-0000-4000-9000-00000000abcd", label: "Load", type: "TEXT" as const, unit: null, value: "A" }] };
    const statements = await saveStatements(part.id, { ...input, steps: [added, ...input.steps] });
    expect(writes(statements)).toEqual([...CLAIMS.slice(0, 4), "UPDATE PartProcessStep", "UPDATE PartProcessStep", "UPDATE PartProcessStep", "UPDATE PartProcessStep",
      "INSERT PartProcessStep", "INSERT PartProcessStepParameter", "INSERT AuditLog"]);
  });
  it("a removed last step deletes its rows and itself, and moves nothing", async () => {
    const { part } = await fixture(3, 2);
    const input = await draft(part.id);
    const statements = await saveStatements(part.id, { ...input, steps: input.steps.slice(0, 2) });
    expect(writes(statements)).toEqual([...CLAIMS.slice(0, 4), "DELETE PartProcessStepParameter", "DELETE PartProcessStep", "INSERT AuditLog"]);
  });
  it("one changed value rewrites that step's rows alone", async () => {
    const { part } = await fixture(3, 2);
    const input = await draft(part.id); input.steps[1].parameters[1].value = "changed";
    const statements = await saveStatements(part.id, input);
    expect(writes(statements)).toEqual([...CLAIMS.slice(0, 4), "DELETE PartProcessStepParameter", "INSERT PartProcessStepParameter", "INSERT AuditLog"]);
  });
});
