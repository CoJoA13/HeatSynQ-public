import { beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { prisma, truncateAll } from "./helpers/db";
import { deleteFixtureAttachments } from "../e2e/lib/attachment-cleanup";

// Execute the actual cleanup functions without importing the executable fixture CLI.
const source = ts.createSourceFile("db-fixtures.ts", readFileSync(new URL("../e2e/lib/db-fixtures.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
// The file's own FIXTURE constant, evaluated from its source rather than copied, because the
// discovery list names some part numbers through it (#348's insecure-origin part).
const fixtureStatement = source.statements.find(n => ts.isVariableStatement(n)
  && n.declarationList.declarations.some(d => d.name.getText(source) === "FIXTURE"));
const FIXTURE = new Function(`${transpile(fixtureStatement!.getText(source))}\nreturn FIXTURE;`)() as Record<string, string>;
function actual<T>(name: string): T {
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  expect(node).toBeDefined();
  const js = transpile(`return (${node!.getText(source)});`);
  // `deleteFixtureAttachments` is the file's one imported helper these functions call.
  return new Function("prisma", "FIXTURE", "deleteFixtureAttachments", js)(prisma, FIXTURE, deleteFixtureAttachments) as T;
}
const discover = actual<(customerId: string) => Promise<{ id: string }[]>>("findNumberedRecipeParts");
const cleanup = actual<(ids: string[]) => Promise<void>>("deletePartProcessData");
const deleteParts = actual<(partIds: string[], customerIds: string[]) => Promise<void>>("deletePartsAndCustomers");
const deleteReference = actual<(scaleIds: string[], codeIds: string[], typeIds: string[]) => Promise<void>>("deletePhase4Reference");
beforeEach(truncateAll);
it("discovers exact recipe fixture numbers only within the owned customer and cleans only supplied owners", async () => {
  const owned = await prisma.customer.create({ data: { code: "OWNED", name: "Owned" } });
  const other = await prisma.customer.create({ data: { code: "OTHER", name: "Other" } });
  const ids: string[] = [];
  for (const [customerId, partNumber] of [[owned.id, "E2E-RECIPE"], [other.id, "E2E-RECIPE"], [owned.id, "DO-NOT-REAP"]]) {
    const p = await prisma.part.create({ data: { customerId, partNumber, eachWeight: 1 } });
    const recipe = await prisma.partRecipe.create({ data: { partId: p.id, number: `R-${ids.length}`, numberKey: `R-${ids.length}`, usedAt: new Date() } });
    const revision = await prisma.partProcessRevision.create({ data: { partId: p.id, revisionNumber: 1, recipeId: recipe.id, lockedAt: new Date() } });
    await prisma.recipeSnapshotField.create({ data: { revisionId: revision.id, fieldDefId: "protected-field" } });
    ids.push(p.id);
  }
  expect(await discover(owned.id)).toEqual([{ id: ids[0] }]);
  await cleanup([]);
  expect(await prisma.partRecipe.count()).toBe(3);
  await cleanup([ids[0]]);
  await cleanup([ids[0]]);
  expect(await prisma.partRecipe.count()).toBe(2);
  expect(await prisma.recipeSnapshotField.count()).toBe(2);
  expect(await prisma.partProcessRevision.count()).toBe(2);
  await prisma.part.delete({ where: { id: ids[0] } });
  expect((await prisma.part.findMany()).map(p => p.id).sort()).toEqual(ids.slice(1).sort());
});
it("discovers the insecure-origin flow's part inside the owned customer only (#348)", async () => {
  expect(FIXTURE.insecurePartNumber).toBe("E2E-INSECURE-ORIGIN");
  const owned = await prisma.customer.create({ data: { code: "OWNED", name: "Owned" } });
  const other = await prisma.customer.create({ data: { code: "OTHER", name: "Other" } });
  const mine = await prisma.part.create({ data: { customerId: owned.id, partNumber: FIXTURE.insecurePartNumber, eachWeight: 1 } });
  await prisma.part.create({ data: { customerId: other.id, partNumber: FIXTURE.insecurePartNumber, eachWeight: 1 } });
  expect(await discover(owned.id)).toEqual([{ id: mine.id }]);
});
it("reaps the deleted parts' own audit rows and nothing else (#348 review)", async () => {
  // POST /api/parts and every process-step save write `part` audit rows keyed by the part's id.
  // The part itself is hard-deleted, so a row left behind is a permanent orphan.
  const customer = await prisma.customer.create({ data: { code: "OWNED", name: "Owned" } });
  const [reaped, kept] = await Promise.all(["E2E-INSECURE-ORIGIN", "KEPT"].map(partNumber =>
    prisma.part.create({ data: { customerId: customer.id, partNumber, eachWeight: 1 } })));
  const audit = (entity: string, entityId: string) =>
    prisma.auditLog.create({ data: { actorName: "test", entity, entityId, action: "create" } });
  await audit("part", reaped.id);
  await audit("part", reaped.id);
  const keptRow = await audit("part", kept.id);
  const otherEntity = await audit("order", reaped.id); // same id, different entity: not the part's
  await deleteParts([], []);
  expect(await prisma.auditLog.count()).toBe(4);
  await deleteParts([reaped.id], []);
  expect(await prisma.part.findMany({ select: { id: true } })).toEqual([{ id: kept.id }]);
  expect((await prisma.auditLog.findMany({ select: { id: true } })).map(r => r.id).sort())
    .toEqual([keptRow.id, otherEntity.id].sort());
});
it("reaps the deleted container types' own audit rows and nothing else (#495 review)", async () => {
  // pick-list-saves saves the E2E Tote's Tare each through the Pick lists screen and puts it back
  // through the same PUT route: each update writes a `containerType` audit row keyed by the type's
  // id. The type itself is hard-deleted, so a row left behind is a permanent orphan.
  const [reaped, kept] = await Promise.all(["E2E Tote", "KEPT"].map(name => prisma.containerType.create({ data: { name } })));
  const audit = (entity: string, entityId: string) =>
    prisma.auditLog.create({ data: { actorName: "test", entity, entityId, action: "update" } });
  await audit("containerType", reaped.id);
  await audit("containerType", reaped.id);
  const keptRow = await audit("containerType", kept.id);
  const otherEntity = await audit("order", reaped.id); // same id, different entity: not the type's
  await deleteReference([], [], []);
  expect(await prisma.auditLog.count()).toBe(4);
  await deleteReference([], [], [reaped.id]);
  expect(await prisma.containerType.findMany({ select: { id: true } })).toEqual([{ id: kept.id }]);
  expect((await prisma.auditLog.findMany({ select: { id: true } })).map(r => r.id).sort())
    .toEqual([keptRow.id, otherEntity.id].sort());
});
