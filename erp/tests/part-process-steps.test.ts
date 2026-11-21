import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  getRevisions, getRevision, lockRevision, lockCurrentRevision, saveRecipeNumber,
} from "@/server/part-process-steps";
import { appendProcessStep, saveProcessDocument } from "@/server/process-document";
import { editedProcess, saveProcessEdit, setInstruction, setValue } from "./helpers/process-edit";
import { createStepCode, updateStepCode, setStepFields } from "@/server/process-step-codes";
import { readAudit } from "@/server/audit";
import { parseRecipeSnapshot } from "@/lib/recipe-snapshot";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** customer -> part -> step code HT-01 with a NUMBER def "Temperature", all via raw prisma —
 *  the steps service under test doesn't (and shouldn't) depend on process-step-codes.ts's own
 *  service layer to set up its own fixtures. */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const fieldDef = await prisma.processStepFieldDef.create({
    data: { codeId: code.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
  });
  return { customer, part, code, fieldDef };
}

describe("part process steps: the revision-cut rule", () => {
  beforeEach(truncateAll);

  it("captures the step's own rows: a copied suggestion left unset is null, with its unit and key", async () => {
    const { part, code, fieldDef } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    await asSystem(() => saveRecipeNumber(part.id, {
      recipeNumber: "001207", expectedRecipeNumber: null,
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const rev = await prisma.partProcessRevision.findUniqueOrThrow({
      where: { partId_revisionNumber: { partId: part.id, revisionNumber: 1 } },
    });
    expect(parseRecipeSnapshot(rev.recipeSnapshot)).toMatchObject({
      schemaVersion: 1, recipeNumber: "001207",
      steps: [{ fields: [{
        fieldDefId: fieldDef.id, label: "Temperature", type: "NUMBER",
        unit: "F", position: 0, value: null,
      }] }],
    });
  });

  it("lists revision summaries when a historical recipe snapshot is malformed", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    await asSystem(() => saveRecipeNumber(part.id, {
      recipeNumber: "001207", expectedRecipeNumber: null,
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "New working settings")));
    await prisma.partProcessRevision.update({
      where: { partId_revisionNumber: { partId: part.id, revisionNumber: 1 } },
      data: { recipeSnapshot: { schemaVersion: 1 } },
    });

    expect(await getRevisions(part.id)).toMatchObject([
      { revisionNumber: 2, recipeNumber: "001207", lockedAt: null, stepCount: 1 },
      { revisionNumber: 1, recipeNumber: "001207", lockedAt: expect.any(Date), stepCount: 1 },
    ]);
    await expect(getRevision(part.id, 1)).rejects.toMatchObject({ name: "ZodError" });
    expect(await getRevision(part.id, 2)).toMatchObject({
      recipeNumber: "001207", steps: [{ instruction: "New working settings" }],
    });
  });

  it("preserves leading zeros and rejects a different part's case variant", async () => {
    const { part, customer } = await fixture();
    const other = await prisma.part.create({ data: {
      customerId: customer.id, partNumber: "P-2", eachWeight: 1,
    } });
    const saved = await asSystem(() => saveRecipeNumber(part.id, {
      recipeNumber: " 00Ab-7 ", expectedRecipeNumber: null,
    }));
    expect(saved.recipeNumber).toBe("00Ab-7");
    await expect(asSystem(() => saveRecipeNumber(other.id, {
      recipeNumber: "00ab-7", expectedRecipeNumber: null,
    }))).rejects.toMatchObject({ status: 409 });
    expect(await prisma.partRecipe.count()).toBe(1);
  });

  it("first mutation lazily creates revision 1", async () => {
    const { part, code } = await fixture();
    expect(await getRevisions(part.id)).toEqual([]);

    const { revisionNumber, stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    expect(revisionNumber).toBe(1);
    expect(stepId).toBeTruthy();

    const revs = await getRevisions(part.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ revisionNumber: 1, lockedAt: null, stepCount: 1 });
    expect(revs[0].createdAt).toBeInstanceOf(Date);
  });

  it("copies an omitted code default, preserves an explicit blank, and never rewrites either", async () => {
    const customer = await prisma.customer.create({ data: { code: "DC", name: "Default Customer" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "D-1", eachWeight: 1 },
    });
    const { id: codeId } = await asSystem(() => createStepCode({
      code: "DF-01", name: "Defaulted", defaultInstruction: "Inspect packaging.",
    }));

    await asSystem(() => appendProcessStep(part.id, { codeId }));
    await asSystem(() => appendProcessStep(part.id, { codeId, instruction: "" }));
    await asSystem(() => updateStepCode(codeId, { defaultInstruction: "New default." }));

    const revision = await getRevision(part.id, 1);
    expect(revision.steps.map((step) => step.instruction)).toEqual(["Inspect packaging.", ""]);
  });

  it("amend-in-place: edits before a lock keep the revision id and number", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "A" }));
    const revId1 = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;

    const r2 = await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "B")));
    const r3 = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "C" }));
    expect(r2.revisionNumber).toBe(1);
    expect(r3.revisionNumber).toBe(1);

    const revId2 = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;
    expect(revId2).toBe(revId1);

    expect(await getRevisions(part.id)).toHaveLength(1);
    const detail = await getRevision(part.id, 1);
    expect(detail.steps).toHaveLength(2);
    expect(detail.steps[0]).toMatchObject({ id: stepId, instruction: "B" });
  });

  it("post-lock edit cuts N+1 copying steps and parameter rows, then applies the change", async () => {
    const { part, code, fieldDef } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, instruction: "A", values: { Temperature: "1650" },
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));

    const { revisionNumber } = await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "B")));
    expect(revisionNumber).toBe(2);

    const rev2 = await getRevision(part.id, 2);
    expect(rev2.steps).toHaveLength(1);
    expect(rev2.steps[0].instruction).toBe("B");
    expect(rev2.steps[0].parameters.find((p) => p.key === fieldDef.id)?.value).toBe("1650");

    // rev 1 re-read: instruction still "A", value still "1650", same step id as before.
    const rev1 = await getRevision(part.id, 1);
    expect(rev1.steps).toHaveLength(1);
    expect(rev1.steps[0].id).toBe(stepId);
    expect(rev1.steps[0].instruction).toBe("A");
    expect(rev1.steps[0].parameters.find((p) => p.key === fieldDef.id)?.value).toBe("1650");
  });

  it("a locked revision's content is byte-identical after post-lock edits", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, instruction: "A", values: { Temperature: "1650" },
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const before = await getRevision(part.id, 1);

    // Cuts to rev 2 and adds a step there — rev 1 must be untouched.
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "in rev 2 now" }));
    expect(await getRevisions(part.id)).toHaveLength(2);

    const after = await getRevision(part.id, 1);
    expect(after).toEqual(before);
  });

  // Owner ruling, spec 2026-09-26 §8: code names still propagate live (no denormalized display
  // columns), but a parameter's label and unit are the PART's own now. A locked revision joins
  // its code live on every read, while its rows carry their own label, unit and value and never
  // follow a suggestion's later edit — what immutability freezes is the whole row.
  it("a locked revision renders a renamed code live, while its rows' labels, units and values stay frozen", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC2", name: "Acme 2" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-2", eachWeight: 1 } });
    // Deliberate typo ("Austentize") and a short label ("Temp") — both get corrected below.
    const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austentize" } });
    const fieldDef = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Temp", type: "NUMBER", sort: 1 },
    });

    const { stepId } = await asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, instruction: "Heat to target temperature.",
      values: { Temp: "1650" },
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const before = await getRevision(part.id, 1);

    // Rename the code and relabel the suggestion, both id-preserving — the step still points at
    // the same codeId, and the row still carries the suggestion's id as its key. (Its type and
    // unit cannot change in place, spec §3.3, so only the label moves.)
    await asSystem(() => updateStepCode(code.id, { code: "HT-01A", name: "Austenitize" }));
    await asSystem(() => setStepFields(code.id, [
      { id: fieldDef.id, label: "Temperature", type: "NUMBER", unit: null, sort: 1 },
    ]));

    const after = await getRevision(part.id, 1);
    expect(after.revisionNumber).toBe(1);
    expect(after.lockedAt).not.toBeNull();
    expect(after.steps[0].id).toBe(stepId);

    // Code vocabulary is live: the SAME locked revision now shows the new spelling.
    expect(after.steps[0].code).toBe("HT-01A");
    expect(after.steps[0].codeName).toBe("Austenitize");
    expect(before.steps[0].code).toBe("HT-01");
    expect(before.steps[0].codeName).toBe("Austentize");

    // The row is frozen whole: key, label, unit and value are what was locked in.
    expect(after.steps[0].instruction).toBe(before.steps[0].instruction);
    expect(after.steps[0].parameters).toEqual(before.steps[0].parameters);
    expect(before.steps[0].parameters).toEqual([{ key: fieldDef.id, label: "Temp", type: "NUMBER", unit: null, position: 0, value: "1650" }]);
  });

  // The single-step cut tests above can't distinguish a correct position-keyed copy from a bug
  // that maps every superseded step id to (say) the last copy — with only one step, any mapping
  // looks identical. Three steps, editing the MIDDLE one by its rev-1 id, forces the map to be
  // right per-step: a wrong mapping would land the edit on the wrong copy, or on the locked
  // revision's own row.
  it("cut preserves every step's position and rows across the copy; the edit lands on only the targeted step", async () => {
    const { part, code, fieldDef } = await fixture();
    const s1 = await asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, instruction: "one", values: { Temperature: "100" },
    }));
    const s2 = await asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, instruction: "two", values: { Temperature: "200" },
    }));
    const s3 = await asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, instruction: "three", values: { Temperature: "300" },
    }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));

    // Named by its rev-1 id — the only id the caller could have, since rev 2 doesn't exist yet.
    const { revisionNumber } = await asSystem(() => saveProcessEdit(part.id, setInstruction(s2.stepId, "TWO-edited")));
    expect(revisionNumber).toBe(2);

    const rev2 = await getRevision(part.id, 2);
    expect(rev2.steps).toHaveLength(3);
    expect(rev2.steps.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(rev2.steps.map((s) => s.instruction)).toEqual(["one", "TWO-edited", "three"]);
    expect(rev2.steps.map((s) => s.parameters.find((p) => p.key === fieldDef.id)?.value))
      .toEqual(["100", "200", "300"]); // every row copied, including the untouched neighbors'

    // rev 1 remains fully intact, not just the one step someone might have thought to check.
    const rev1 = await getRevision(part.id, 1);
    expect(rev1.steps.map((s) => s.instruction)).toEqual(["one", "two", "three"]);
    expect(rev1.steps.map((s) => s.id)).toEqual([s1.stepId, s2.stepId, s3.stepId]);
  });

  it("a reorder saved against a locked revision resolves rev-1 step ids through the cut", async () => {
    const { part, code } = await fixture();
    const s1 = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "one" }));
    const s2 = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "two" }));
    const s3 = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "three" }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));

    // The working revision (rev 2) doesn't exist until this save — the rev-1 ids are the only
    // ones the caller could possibly send.
    const { revisionNumber } = await asSystem(() => saveProcessEdit(part.id, (steps) =>
      [s3, s1, s2].map(({ stepId }) => steps.find((step) => step.stepId === stepId)!)));
    expect(revisionNumber).toBe(2);

    const rev2 = await getRevision(part.id, 2);
    expect(rev2.steps.map((s) => s.instruction)).toEqual(["three", "one", "two"]);
    expect(rev2.steps.map((s) => s.position)).toEqual([1, 2, 3]);

    const rev1 = await getRevision(part.id, 1);
    expect(rev1.steps.map((s) => s.instruction)).toEqual(["one", "two", "three"]);
  });

  // Regression for the concurrency hole Codex found on MR !22: the mutator read `lockedAt: null`,
  // a lock committed, and the mutator then wrote a child step of the now-locked revision and
  // committed clean. Its Serializable isolation did not prevent this — Postgres only gives
  // serializable guarantees among transactions that are ALL Serializable, and lockRevision's
  // documented caller (Phase 3's order save) runs at the default isolation, exactly as the E2E
  // fixture does. The fix is a row lock, which both sides take regardless of isolation, so this
  // interleaving must now end in either a clean N+1 cut or a 40001 — never a modified lock.
  it("a lock landing mid-mutation cannot leave the locked revision modified", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "before" }));

    let hasLocked!: () => void;
    const locked = new Promise<void>((resolve) => { hasLocked = resolve; });
    let mayCommit!: () => void;
    const release = new Promise<void>((resolve) => { mayCommit = resolve; });

    // Phase 3's order save, held open: lockRevision has run and holds the revision row, but the
    // transaction has not committed. Default isolation, exactly as the E2E fixture and the
    // documented future caller use — the whole point is that the mutator cannot rely on its own
    // Serializable setting to order against this.
    const lockTxn = asSystem(() => prisma.$transaction(async (tx) => {
      await lockRevision(part.id, 1, tx);
      hasLocked();
      await release;
    }, { timeout: 20000 }));

    await locked;
    // The editor saves into that window. It must not be able to read "unlocked" and go on to
    // amend revision 1 in place.
    const mutation = asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "after")));
    await new Promise((r) => setTimeout(r, 300)); // let the mutation reach the revision row
    mayCommit();
    await lockTxn;

    // Either ordering is acceptable — a clean N+1 cut, or a 409 (the serialization failure, or the
    // save's stale-baseline refusal) with nothing written. A modified locked revision is not.
    let cutTo: number | null = null;
    try {
      cutTo = (await mutation).revisionNumber;
    } catch (err) {
      expect(err).toMatchObject({ status: 409 });
    }

    const rev1 = await getRevision(part.id, 1);
    expect(rev1.lockedAt).not.toBeNull();
    expect(rev1.steps.map((s) => s.instruction)).toEqual(["before"]);
    if (cutTo !== null) expect(cutTo).toBe(2);
  });

  // A cut copies every step to a NEW id, so client state keyed by step id has nothing to match
  // against afterwards — which is how a structural action on a locked revision silently discarded
  // whatever the user had typed into some other step (Codex, MR !22). The document save therefore
  // answers with the id each submitted row landed on, following the cut.
  it("returns the cut's old-to-new step id mapping, and each row's own id when amending in place", async () => {
    const { part, code } = await fixture();
    const first = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "one" }));
    const second = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "two" }));
    // Amend in place: nothing was cut, so every row keeps its own id.
    const amended = await asSystem(() => saveProcessEdit(part.id, setInstruction(second.stepId, "two edited")));
    expect(amended.revisionNumber).toBe(1);
    expect(amended.stepIdMap).toEqual({ [first.stepId]: first.stepId, [second.stepId]: second.stepId });

    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const afterCut = await asSystem(() => saveProcessEdit(part.id, setInstruction(first.stepId, "one edited")));
    expect(afterCut.revisionNumber).toBe(2);

    // Every step of the locked revision appears exactly once, pointing at its copy on rev 2.
    const rev1 = await getRevision(part.id, 1);
    const rev2 = await getRevision(part.id, 2);
    expect(Object.keys(afterCut.stepIdMap).sort()).toEqual(rev1.steps.map((s) => s.id).sort());
    expect(Object.values(afterCut.stepIdMap).sort()).toEqual(rev2.steps.map((s) => s.id).sort());
    // The mapping is position-faithful: following an old id lands on the step that succeeded it.
    for (const old of rev1.steps) {
      const copy = rev2.steps.find((s) => s.id === afterCut.stepIdMap[old.id]);
      expect(copy?.position).toBe(old.position);
      expect(copy?.codeId).toBe(old.codeId);
    }
  });

  it("lockRevision is idempotent and 404s on a missing revision", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const revId = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;
    // appendProcessStep already wrote its own create+update pair against this same entityId, so
    // the baseline count (not just entries[0]) is what proves the lock itself wrote something.
    const auditBeforeLock = await readAudit("partProcessRevision", revId);

    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const auditAfterFirstLock = await readAudit("partProcessRevision", revId);
    expect(auditAfterFirstLock).toHaveLength(auditBeforeLock.length + 1);
    const lockEntry = auditAfterFirstLock[0];
    expect(lockEntry.action).toBe("update");
    expect((lockEntry.after as { lockedAt: string | null }).lockedAt).not.toBeNull();
    const lockedAtAfterFirst =
      (await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: revId } })).lockedAt;
    expect(lockedAtAfterFirst).not.toBeNull();

    // A second lock is a silent no-op — no error, no new audit entry, and the timestamp itself
    // is untouched (not just "still non-null" — a re-stamped lockedAt would also pass a weaker
    // check).
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const auditAfterSecondLock = await readAudit("partProcessRevision", revId);
    expect(auditAfterSecondLock).toHaveLength(auditAfterFirstLock.length);
    const lockedAtAfterSecond =
      (await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: revId } })).lockedAt;
    expect(lockedAtAfterSecond).toEqual(lockedAtAfterFirst);

    await expect(asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 99, tx))))
      .rejects.toMatchObject({ status: 404 });
  });

  it("values are typed per row with label-anchored messages; an unsuggested label is refused; an empty value keeps its row", async () => {
    const { part, code, fieldDef } = await fixture(); // fieldDef: NUMBER "Temperature"
    const dateDef = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Heat date", type: "DATE", sort: 2 },
    });
    const checkboxDef = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Certified", type: "CHECKBOX", sort: 3 },
    });
    const textDef = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Notes", type: "TEXT", sort: 4 },
    });

    await expect(asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, values: { Temperature: "hot" },
    }))).rejects.toThrow('"hot" is not a valid number for Temperature');

    await expect(asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, values: { "Heat date": "2025-02-29" },
    }))).rejects.toThrow('"2025-02-29" is not a valid date (yyyy-mm-dd) for Heat date');

    await expect(asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, values: { Certified: "yes" },
    }))).rejects.toThrow("Certified must be true or false");

    // TEXT accepts free-form text up to the process document schema's own 500-char value cap
    // (lib/process-document.ts), which makes validateStepValue's own TEXT-length guard defensively
    // unreachable through the public API — the mirrored part-field-values.ts shape keeps it anyway
    // as a second line of defense (its VALUES schema has no such cap, so the equivalent branch
    // there IS reachable).
    await expect(asSystem(() => appendProcessStep(part.id, {
      codeId: code.id, values: { Notes: "x".repeat(501) },
    }))).rejects.toThrow();

    // A label the code does not suggest is refused: there is no row to hold its value.
    const otherCode = await prisma.processStepCode.create({ data: { code: "WS-01", name: "Wash" } });
    await expect(asSystem(() => appendProcessStep(part.id, {
      codeId: otherCode.id, values: { Temperature: "1650" },
    }))).rejects.toThrow('"Temperature" is not a suggested parameter of this code');

    // Valid values of every type are accepted together, including a real leap day; the rows keep
    // the suggestions' order and ids.
    const { stepId } = await asSystem(() => appendProcessStep(part.id, {
      codeId: code.id,
      values: { Temperature: "1650", "Heat date": "2024-02-29", Certified: "true", Notes: "ok" },
    }));
    let parameters = (await getRevision(part.id, 1)).steps[0].parameters;
    expect(parameters.map((p) => [p.key, p.value])).toEqual([
      [fieldDef.id, "1650"], [dateDef.id, "2024-02-29"], [checkboxDef.id, "true"], [textDef.id, "ok"],
    ]);

    // An empty value keeps its row (spec 2026-09-26 §3.1): it prints as a blank.
    await asSystem(() => saveProcessEdit(part.id, setValue(stepId, fieldDef.id, "")));
    parameters = (await getRevision(part.id, 1)).steps[0].parameters;
    expect(parameters.find((p) => p.key === fieldDef.id)).toMatchObject({ label: "Temperature", value: "" });
    expect(parameters).toHaveLength(4);
  });

  // #283: the revision cut copies EVERY step of a locked revision — it cannot know why it was
  // called — so on the cut branch its internal map carries the step a removal is about to delete.
  // Returning that entry advertises a mapping onto a row this very transaction hard-deleted, and the
  // process editor once followed it: the removed step's unsaved draft was re-keyed onto the dead
  // copy, after which nothing on screen could reach or clear it and the page stayed registered
  // unsaved for good. The document save answers only for the rows it was sent.
  //
  // The everyday reachability is what makes it worth a DB-level assertion rather than a client
  // one: an order save locks the part's current revision (`lockCurrentRevision`, order-create.ts),
  // so for any part that has ever been ordered this IS the branch a removal takes.
  it("a save that removes a step from a locked revision never maps the step it deleted", async () => {
    const { part, code } = await fixture();
    const doomed = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "doomed" }));
    const keeper = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "keeper" }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));

    const res = await asSystem(() => saveProcessEdit(part.id, (steps) => steps.filter((step) => step.stepId !== doomed.stepId)));
    expect(res.revisionNumber, "removing from a locked revision must cut N+1").toBe(2);

    // The removed step is absent from the mapping — mutation-proof: merge the cut's own copy map
    // into the save's answer and this key is present, pointing at the copy the same transaction
    // deleted.
    expect(Object.keys(res.stepIdMap)).not.toContain(doomed.stepId);

    // ...and the survivor is still mapped, onto a step that really exists on the new revision.
    // Without this half the assertion above would pass on a `stepIdMap: {}` that dropped everyone's
    // drafts — the Codex MR !22 regression the mapping exists to prevent.
    expect(Object.keys(res.stepIdMap)).toContain(keeper.stepId);
    const rev2 = await getRevision(part.id, 2);
    expect(rev2.steps.map((st) => st.id)).toContain(res.stepIdMap[keeper.stepId]);
    expect(rev2.steps).toHaveLength(1);
  });

  it("audit: a step edit writes a revision-level update whose after-snapshot shows the change", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "A" }));
    const revId = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;

    await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "B")));

    const entries = await readAudit("partProcessRevision", revId);
    expect(entries[0].action).toBe("update");
    const after = entries[0].after as { steps: { instruction: string }[] };
    expect(after.steps.some((s) => s.instruction === "B")).toBe(true);
    const before = entries[0].before as { steps: { instruction: string }[] };
    expect(before.steps.some((s) => s.instruction === "B")).toBe(false);
  });

  it("audit: a parameter edit's before and after images carry each row's key, label, type, unit and value, and show exactly what changed", async () => {
    const { part, code, fieldDef } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, parameters: [
      { key: fieldDef.id, label: "Temperature", type: "NUMBER", unit: "F", value: "1500" },
      { key: `new:${randomUUID()}`, label: "Load", type: "TEXT", unit: null, value: "Basket A" },
    ] }));
    const revId = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;
    const [, loadKey] = (await getRevision(part.id, 1)).steps[0].parameters.map((p) => p.key);

    // One save: a value and a label edit on the copied row (its key stays), and a unit edit on the
    // hand-added row (a new key, spec 2026-09-26 §3.3).
    const saved = await asSystem(() => saveProcessEdit(part.id, (steps) => steps.map((s) => ({ ...s, parameters: [
      { ...s.parameters[0], label: "Furnace temperature", value: "1550" },
      { ...s.parameters[1], unit: "bin" },
    ] }))));
    const [, rekeyed] = saved.parameterKeys[stepId];
    expect(rekeyed).not.toBe(loadKey);

    const [entry] = await readAudit("partProcessRevision", revId);
    type Image = { steps: { parameters: unknown[] }[] };
    expect((entry.before as Image).steps[0].parameters).toEqual([
      { key: fieldDef.id, label: "Temperature", type: "NUMBER", unit: "F", value: "1500" },
      { key: loadKey, label: "Load", type: "TEXT", unit: null, value: "Basket A" },
    ]);
    expect((entry.after as Image).steps[0].parameters).toEqual([
      { key: fieldDef.id, label: "Furnace temperature", type: "NUMBER", unit: "F", value: "1550" },
      { key: rekeyed, label: "Load", type: "TEXT", unit: "bin", value: "Basket A" },
    ]);
  });

  // Fix-wave Finding 4 (2026-08-02 final review, ride-along): SNAPSHOT_INCLUDE.partProcessRevision's
  // nested rows include needs an `orderBy`, or a snapshot's row order depends on Postgres's own
  // (unspecified, plan-dependent) scan order rather than being deterministic — two snapshots of
  // identical state could render as a spurious "steps changed" diff in HistoryPanel, which diffs
  // whole keys via `JSON.stringify` (order-sensitive). This reproduces the bug the way it
  // surfaces: two steps, rows inserted interleaved across them and out of position order, plus an
  // UPDATE (which gives one row a new physical/MVCC placement). The BEFORE image is what proves
  // it: the save rewrites every step's rows in position order, so the after image would come back
  // ordered even with no `orderBy` at all.
  it("audit snapshot orders every step's parameters by position, not scan/insertion order", async () => {
    const { part, code } = await fixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const step1 = await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "" },
    });
    const step2 = await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 2, codeId: code.id, instruction: "" },
    });
    const row = (stepId: string, position: number, key: string, value: string) =>
      prisma.partProcessStepParameter.create({ data: { stepId, position, key, label: key, type: "TEXT", unit: null, value } });

    // Interleaved across the two steps, deliberately not in position order.
    await row(step2.id, 2, "c", "x");
    await row(step1.id, 2, "c", "y");
    await row(step2.id, 0, "a", "1");
    await row(step1.id, 1, "b", "true");
    await row(step2.id, 1, "b", "false");
    await row(step1.id, 0, "a", "2");
    // An UPDATE gives its row a fresh MVCC tuple version — the mechanism that scrambled scan order
    // in the repro against pre-fix code.
    await prisma.partProcessStepParameter.updateMany({ where: { stepId: step1.id, key: "a" }, data: { value: "2.5" } });

    // Any real mutation on the revision snapshots it — the instruction edit itself is irrelevant,
    // only the resulting `before.steps[].parameters` order is under test.
    await asSystem(() => saveProcessEdit(part.id, setInstruction(step1.id, "touched")));

    const entries = await readAudit("partProcessRevision", rev.id);
    const before = entries[0].before as { steps: { position: number; parameters: { key: string }[] }[] };
    const expected = ["a", "b", "c"];
    expect(before.steps.find((s) => s.position === 1)!.parameters.map((p) => p.key)).toEqual(expected);
    expect(before.steps.find((s) => s.position === 2)!.parameters.map((p) => p.key)).toEqual(expected);
  });

  it("getRevisions/getRevision 404 on a missing part, a deleted part, or a missing revision number", async () => {
    await expect(getRevisions("nonexistent")).rejects.toMatchObject({ status: 404 });
    await expect(getRevision("nonexistent", 1)).rejects.toMatchObject({ status: 404 });

    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    await expect(getRevision(part.id, 2)).rejects.toMatchObject({ status: 404 });

    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    await expect(getRevisions(part.id)).rejects.toMatchObject({ status: 404 });
    await expect(getRevision(part.id, 1)).rejects.toMatchObject({ status: 404 });
  });

  /** Orders built directly: the count is a read over saved rows, so the fixture states each row
   *  (a lead line's `revisionNumber`, a rider line, a voided order) rather than deriving it. */
  async function orderLed(customerId: string, orderNumber: number, lines: { partId: string; position: number; revisionNumber: number | null }[], deletedAt: Date | null = null) {
    return prisma.order.create({ data: { customerId, orderNumber, receivedDate: new Date("2026-09-01"), requestDate: new Date("2026-09-08"), deletedAt,
      lines: { create: lines.map((l) => ({ ...l, qty: 1, weight: 1 })) } } });
  }

  it("order count: live orders whose lead line saved a revision count once each; a voided order, a rider line and another part's order never do (owner ruling 2026-09-26)", async () => {
    const { part, code, customer } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    // A post-lock edit cuts revision 2, which no order has saved yet.
    await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "Working settings")));
    const other = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-2", eachWeight: 1 } });
    await orderLed(customer.id, 1001, [{ partId: part.id, position: 1, revisionNumber: 1 }]);
    await orderLed(customer.id, 1002, [{ partId: part.id, position: 1, revisionNumber: 1 }, { partId: other.id, position: 2, revisionNumber: null }]);
    await orderLed(customer.id, 1003, [{ partId: part.id, position: 1, revisionNumber: 1 }], new Date()); // voided
    await orderLed(customer.id, 1004, [{ partId: other.id, position: 1, revisionNumber: 1 }, { partId: part.id, position: 2, revisionNumber: 1 }]); // this part rides, never leads
    await orderLed(customer.id, 1005, [{ partId: part.id, position: 1, revisionNumber: null }]); // saved before any revision was locked
    expect(await getRevisions(part.id)).toMatchObject([
      { revisionNumber: 2, lockedAt: null, orderCount: 0 },
      { revisionNumber: 1, lockedAt: expect.any(Date), orderCount: 2 },
    ]);
    expect(await getRevisions(other.id)).toEqual([]);
  });

  it("order count: the revisions and their counts come from ONE read-only RepeatableRead snapshot (figures shown together are read together)", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    // Plain save/restore of the client's own method, never `vi.spyOn` (CLAUDE.md). The proxy
    // records which delegates the callback reaches THROUGH the transaction client, so a count read
    // that slipped back onto the top-level singleton — a second autocommit snapshot — is a
    // missing name here, not a green run.
    const client = prisma as unknown as { $transaction: (...args: unknown[]) => unknown };
    const real = client.$transaction;
    const opened: { options: unknown; delegates: string[] }[] = [];
    client.$transaction = function (fn: unknown, options?: unknown) {
      const record = { options, delegates: [] as string[] }; opened.push(record);
      if (typeof fn !== "function") return real.call(prisma, fn, options);
      return real.call(prisma, (tx: Record<string | symbol, unknown>) => fn(new Proxy(tx, {
        get(target, property) { if (typeof property === "string" && !property.startsWith("$")) record.delegates.push(property); return target[property]; },
      })), options);
    };
    let summaries;
    try { summaries = await getRevisions(part.id); } finally { client.$transaction = real; }
    expect(summaries).toMatchObject([{ revisionNumber: 1, orderCount: 0 }]);
    expect(opened).toHaveLength(1);
    expect(opened[0].options).toEqual({ isolationLevel: "RepeatableRead" });
    expect(new Set(opened[0].delegates)).toEqual(new Set(["part", "partProcessRevision", "orderLine"]));
  });
});

describe("part process steps: lockCurrentRevision", () => {
  beforeEach(truncateAll);

  it('400s "This part has no process steps" when the part has no revision at all', async () => {
    const { part } = await fixture();
    await expect(asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx))))
      .rejects.toMatchObject({ status: 400, message: "This part has no process steps" });
  });

  it('400s "This part has no process steps" when the current revision has zero steps', async () => {
    const { part } = await fixture();
    await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await expect(asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx))))
      .rejects.toMatchObject({ status: 400, message: "This part has no process steps" });
  });

  // Fix round 1 (Task 3 review, Finding 2): lockCurrentRevision omitted the part-existence/
  // soft-delete guard every sibling in this file opens with (workingRevision's own first line).
  it('404s "Part not found" for an unknown partId', async () => {
    await expect(asSystem(() => prisma.$transaction((tx) => lockCurrentRevision("nonexistent", tx))))
      .rejects.toMatchObject({ status: 404, message: "Part not found" });
  });

  it("404s a soft-deleted part with a step-bearing revision, and never locks it", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });

    await expect(asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx))))
      .rejects.toMatchObject({ status: 404, message: "Part not found" });

    // getRevision itself 404s on a soft-deleted part (by design), so read the row directly to
    // prove the guard fired before the claim ever touched it.
    const rev = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } });
    expect(rev.lockedAt).toBeNull();
  });

  it("returns the highest revisionNumber and sets lockedAt", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "rev1" }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    // Already locked, so this append cuts to rev 2 — proves lockCurrentRevision targets the
    // highest revision, not just "the only one".
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "rev2" }));

    const result = await asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx)));
    expect(result).toEqual({ revisionNumber: 2 });

    const rev2 = await getRevision(part.id, 2);
    expect(rev2.lockedAt).not.toBeNull();
  });

  it("is idempotent: second call returns the same result and writes no second audit entry", async () => {
    const { part, code } = await fixture();
    await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    const revId = (await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).id;
    const auditBefore = await readAudit("partProcessRevision", revId);

    const first = await asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx)));
    expect(first).toEqual({ revisionNumber: 1 });
    const auditAfterFirst = await readAudit("partProcessRevision", revId);
    expect(auditAfterFirst).toHaveLength(auditBefore.length + 1);

    const second = await asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx)));
    expect(second).toEqual({ revisionNumber: 1 });
    const auditAfterSecond = await readAudit("partProcessRevision", revId);
    expect(auditAfterSecond).toHaveLength(auditAfterFirst.length);
  });

  // 2C-3 race regression (the original, above, is "a lock landing mid-mutation cannot leave the
  // locked revision modified") rerun against this caller: lockCurrentRevision's claim is the same
  // FOR UPDATE the process-document save takes, so it has to serialize against that save exactly
  // the same way lockRevision's documented caller does. Ordering A: the lock wins the claim first,
  // held open with explicit signals — same technique as the original test.
  it("lockCurrentRevision landing mid-mutation cannot leave the locked revision modified", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "before" }));

    let hasLocked!: () => void;
    const locked = new Promise<void>((resolve) => { hasLocked = resolve; });
    let mayCommit!: () => void;
    const release = new Promise<void>((resolve) => { mayCommit = resolve; });

    const lockTxn = asSystem(() => prisma.$transaction(async (tx) => {
      await lockCurrentRevision(part.id, tx);
      hasLocked();
      await release;
    }, { timeout: 20000 }));

    await locked;
    // The editor saves into that window. It must not be able to read "unlocked" and go on to
    // amend revision 1 in place.
    const mutation = asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "after")));
    await new Promise((r) => setTimeout(r, 300)); // let the mutation reach the revision row
    mayCommit();
    await lockTxn;

    // Either ordering is acceptable — a clean N+1 cut, or a 409 (the serialization failure, or the
    // save's stale-baseline refusal) with nothing written. A modified locked revision is not.
    let cutTo: number | null = null;
    try {
      cutTo = (await mutation).revisionNumber;
    } catch (err) {
      expect(err).toMatchObject({ status: 409 });
    }

    const rev1 = await getRevision(part.id, 1);
    expect(rev1.lockedAt).not.toBeNull();
    expect(rev1.steps.map((s) => s.instruction)).toEqual(["before"]);
    if (cutTo !== null) expect(cutTo).toBe(2);
  });

  // Ordering B: the save reaches the claim first. Unlike lockRevision (a single exported
  // `updateMany`), the save's claim runs inside its own transaction, so there is no hook to hold it
  // open mid-flight from a test the way the lock side above is held open. The editor's document is
  // read first, as an open page holds it; firing the save and the lock without awaiting between
  // starts (same technique as allocate-number.test.ts's concurrency case) then lets the row lock
  // itself decide who actually claims first. Either arrival order is a legitimate outcome (the save
  // amends and the lock follows it, or the lock lands first and the save's baseline is stale — a
  // 409), so the assertion below covers both instead of pinning one.
  it("a process save landing mid-lock-claim cannot leave the locked revision modified", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "before" }));
    const input = await editedProcess(part.id, setInstruction(stepId, "after"));

    const mutation = asSystem(() => saveProcessDocument(part.id, input));
    const lockCall = asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx)));

    // lockCurrentRevision runs at default isolation here (mirroring the documented future
    // caller), so it never itself takes a serialization failure — it either claims cleanly or
    // waits behind the save's row lock and then claims cleanly.
    const lockResult = await lockCall;
    expect(lockResult.revisionNumber).toBe(1);

    let mutationOutcome: number | null = null;
    try {
      mutationOutcome = (await mutation).baseline.revision?.revisionNumber ?? null;
    } catch (err) {
      expect(err).toMatchObject({ status: 409 });
    }

    const rev1 = await getRevision(part.id, 1);
    expect(rev1.lockedAt).not.toBeNull();
    if (mutationOutcome === 1) {
      // The save won the claim first and amended in place before the lock landed — a clean
      // sequential history (update, then lock), not corruption.
      expect(rev1.steps.map((s) => s.instruction)).toEqual(["after"]);
    } else {
      // The lock won the claim first, so the save's baseline was stale and it was refused with a
      // 409 — nothing it did committed.
      expect(mutationOutcome).toBeNull();
      expect(rev1.steps.map((s) => s.instruction)).toEqual(["before"]);
    }
  });

  // Fix round 1 (Task 3 review, Finding 1): neither race test above can detect the FOR UPDATE
  // being deleted from lockCurrentRevision's own claim — ordering A only proves lockRevision's
  // updateMany serializes (true with or without the claim's own lock), and ordering B is
  // deterministic-sequential per the 12/12 evidence in the task report.
  //
  // A first replacement attempt (holder takes the claim's exact row lock and just sits on it,
  // lockCurrentRevision raced in, asserted "not settled within 200ms") was tried and DISCARDED —
  // empirically, it passes even with the FOR UPDATE deleted, because lockRevision's own
  // `updateMany` targets the same row and blocks on the holder regardless of whether the claim
  // itself took a lock first. That write only ever checks `lockedAt: null`, so blocking there
  // doesn't depend on — and can't discriminate — the claim's own lock. Full evidence in the task
  // report's Fix round 1 section.
  //
  // This version instead has the holder delete the revision's only step *while holding the claim
  // lock*, then release. A genuine FOR UPDATE claim cannot read past the holder until it commits,
  // so lockCurrentRevision's step-count check necessarily runs on the fresh, post-delete state and
  // correctly refuses. A plain SELECT (the regression) reads the step count *before* the holder's
  // delete is visible, decides "has steps" on stale data, and — because lockRevision's own write
  // only guards on `lockedAt`, never on step count — goes on to lock a revision that, by the time
  // that write actually lands, has none. That is an observable, not just a timing, difference.
  it("lockCurrentRevision cannot lock a revision that loses its last step while the claim is held", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // Same claim SQL workingRevision/lockCurrentRevision use, run directly here since
    // workingRevision is private to the module.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "PartProcessRevision"
        WHERE "partId" = ${part.id} ORDER BY "revisionNumber" DESC LIMIT 1 FOR UPDATE`;
      hasClaimed();
      await release;
      // Only now, still inside the same held transaction: remove the last step (its copied
      // parameter row first — the FK restricts) before committing (and releasing the row lock).
      await tx.partProcessStepParameter.deleteMany({ where: { stepId } });
      await tx.partProcessStep.delete({ where: { id: stepId } });
    }, { timeout: 20000 });

    await claimed;
    const lockCall = asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx)));

    // Not itself the discriminator (see above) — its job is to guarantee lockCurrentRevision's
    // claim has actually been dispatched, and in the correct implementation is genuinely blocked
    // on the holder, before the holder is released — otherwise the stale-vs-fresh read below
    // would be a coincidence of scheduling rather than a real test of the claim.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      lockCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: with the FOR UPDATE genuinely in effect, lockCurrentRevision cannot
    // decide "has steps" until after the holder's delete has committed, so it must see zero steps
    // and refuse — the revision is never locked.
    await expect(lockCall).rejects.toMatchObject({ status: 400, message: "This part has no process steps" });
    const rev1 = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } });
    expect(rev1.lockedAt).toBeNull();
  });
});

describe("part recipe identities", () => {
  beforeEach(truncateAll);

  it("accepts identifier boundaries and refuses invalid numbers without creating a revision", async () => {
    const { part } = await fixture();
    for (const recipeNumber of ["", " ", "a".repeat(21), "A B", "A_B", "é", "１２", "A\nB"]) {
      await expect(asSystem(() => saveRecipeNumber(part.id, { recipeNumber, expectedRecipeNumber: null })))
        .rejects.toMatchObject({ status: 400 });
    }
    expect(await prisma.partProcessRevision.count()).toBe(0);
    expect(await prisma.partRecipe.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "0", expectedRecipeNumber: null }));
    const result = await asSystem(() => saveRecipeNumber(part.id, {
      recipeNumber: "aB-01234567890123456", expectedRecipeNumber: "0",
    }));
    expect(result.recipeNumber).toBe("aB-01234567890123456");
    expect(result.revisionNumber).toBe(1);
  });

  it("rejects nonobjects, missing keys, and extra keys before database access", async () => {
    for (const input of [null, [], "1", {}, { recipeNumber: "1" },
      { recipeNumber: "1", expectedRecipeNumber: null, unexpected: true }]) {
      await expect(saveRecipeNumber("nonexistent", input as Parameters<typeof saveRecipeNumber>[1]))
        .rejects.toMatchObject({ name: "ZodError" });
    }
  });

  it("null no-op creates nothing; same-number retries ignore stale baselines without audit or revision noise", async () => {
    const { part } = await fixture();
    const before = await prisma.part.findUniqueOrThrow({ where: { id: part.id } });
    expect(await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: null, expectedRecipeNumber: null })))
      .toMatchObject({ recipeNumber: null, revisionNumber: null });
    expect(await prisma.partProcessRevision.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.part.findUniqueOrThrow({ where: { id: part.id } })).toEqual(before);
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "001", expectedRecipeNumber: null }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const auditCount = await prisma.auditLog.count();
    expect(await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: " 001 ", expectedRecipeNumber: null })))
      .toMatchObject({ recipeNumber: "001", revisionNumber: 1 });
    expect(await prisma.partProcessRevision.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(auditCount);
  });

  it("refuses stale changes and releases corrected or removed numbers before use", async () => {
    const { part, customer } = await fixture();
    const other = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-2", eachWeight: 1 } });
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "A", expectedRecipeNumber: null }));
    await expect(asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "B", expectedRecipeNumber: null })))
      .rejects.toMatchObject({ status: 409 });
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "B", expectedRecipeNumber: "A" }));
    await asSystem(() => saveRecipeNumber(other.id, { recipeNumber: "a", expectedRecipeNumber: null }));
    expect(await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: null, expectedRecipeNumber: "B" })))
      .toMatchObject({ recipeNumber: null, revisionNumber: 1 });
    expect((await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).recipeId).toBeNull();
    await asSystem(() => saveRecipeNumber(other.id, { recipeNumber: "b", expectedRecipeNumber: "a" }));
    expect(await prisma.partRecipe.count()).toBe(1);
  });

  it("first lock permanently reserves the number; later revisions inherit identity without snapshots", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id }));
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "00Ab", expectedRecipeNumber: null }));
    await asSystem(() => prisma.$transaction((tx) => lockCurrentRevision(part.id, tx)));
    const identity = await prisma.partRecipe.findUniqueOrThrow({ where: { partId: part.id } });
    expect(identity.usedAt).toBeInstanceOf(Date);
    for (const recipeNumber of [null, "NEXT", "00ab"]) {
      await expect(asSystem(() => saveRecipeNumber(part.id, { recipeNumber, expectedRecipeNumber: "00Ab" })))
        .rejects.toMatchObject({ status: 409 });
    }
    // A stored snapshot on the source must never leak into the new working revision. The first
    // lock captured one; the process-document save reads and validates it, so it stays well-formed.
    expect((await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } })).recipeSnapshot).not.toBeNull();
    await asSystem(() => saveProcessEdit(part.id, setInstruction(stepId, "new")));
    const next = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id, revisionNumber: 2 } });
    expect(next.recipeId).toBe(identity.id);
    expect(next.recipeSnapshot).toBeNull();
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 2, tx)));
    expect((await prisma.partRecipe.findUniqueOrThrow({ where: { id: identity.id } })).usedAt).toEqual(identity.usedAt);
  });

  it("deleting an unused or used part keeps its number reserved and editor writes refuse it", async () => {
    const { part, customer } = await fixture();
    const other = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-2", eachWeight: 1 } });
    for (const used of [false, true]) {
      const owner = used ? await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-3", eachWeight: 1 } }) : part;
      const number = used ? "USED" : "UNUSED";
      await asSystem(() => saveRecipeNumber(owner.id, { recipeNumber: number, expectedRecipeNumber: null }));
      if (used) await asSystem(() => prisma.$transaction((tx) => lockRevision(owner.id, 1, tx)));
      await prisma.part.update({ where: { id: owner.id }, data: { deletedAt: new Date() } });
      await expect(asSystem(() => saveRecipeNumber(other.id, { recipeNumber: number, expectedRecipeNumber: null })))
        .rejects.toMatchObject({ status: 409 });
      await expect(asSystem(() => saveRecipeNumber(owner.id, { recipeNumber: null, expectedRecipeNumber: number })))
        .rejects.toMatchObject({ status: 404 });
    }
    expect(await prisma.partRecipe.count()).toBe(2);
  });

  it("assigning to locked legacy content cuts N+1 and returns the copied step mapping", async () => {
    const { part, code } = await fixture();
    const { stepId } = await asSystem(() => appendProcessStep(part.id, { codeId: code.id, instruction: "keep" }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(part.id, 1, tx)));
    const old = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } });
    const result = await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "001", expectedRecipeNumber: null }));
    expect(result.revisionNumber).toBe(2);
    const nextStep = await prisma.partProcessStep.findFirstOrThrow({ where: { revision: { partId: part.id, revisionNumber: 2 } } });
    expect(result.stepIdMap).toEqual({ [stepId]: nextStep.id });
    expect(nextStep.instruction).toBe("keep");
    expect(await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(old.recipeId).toBeNull();
    expect(old.recipeSnapshot).toBeNull();
  });

  it("two simultaneous assignments of one number have one winner and no partial loser audit", async () => {
    const { part, customer } = await fixture();
    const other = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-2", eachWeight: 1 } });
    const results = await Promise.allSettled([part, other].map((owner) => asSystem(() =>
      saveRecipeNumber(owner.id, { recipeNumber: "race-01", expectedRecipeNumber: null }))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409 });
    const winner = await prisma.partRecipe.findFirstOrThrow();
    const loserId = winner.partId === part.id ? other.id : part.id;
    expect(await prisma.partRecipe.count()).toBe(1);
    expect(await prisma.partProcessRevision.count({ where: { partId: loserId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entity: "part", entityId: loserId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entity: "partProcessRevision" } })).toBe(2);
  });

  it("same-part competing first assignments refuse the stale loser", async () => {
    const { part } = await fixture();
    const results = await Promise.allSettled(["A", "B"].map((recipeNumber) => asSystem(() =>
      saveRecipeNumber(part.id, { recipeNumber, expectedRecipeNumber: null }))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ status: 409 });
    expect(await prisma.partRecipe.count()).toBe(1);
    expect(await prisma.partProcessRevision.count()).toBe(1);
  });

  it("duplicate assignment rolls back a revision cut and its audit; assignment and removal audit both owners", async () => {
    const { part, code, customer } = await fixture();
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: "TAKEN", expectedRecipeNumber: null }));
    const other = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-2", eachWeight: 1 } });
    await asSystem(() => appendProcessStep(other.id, { codeId: code.id }));
    await asSystem(() => prisma.$transaction((tx) => lockRevision(other.id, 1, tx)));
    const auditBefore = await prisma.auditLog.findMany({ orderBy: { id: "asc" } });
    await expect(asSystem(() => saveRecipeNumber(other.id, { recipeNumber: "taken", expectedRecipeNumber: null })))
      .rejects.toMatchObject({ status: 409 });
    expect(await prisma.partProcessRevision.count({ where: { partId: other.id } })).toBe(1);
    expect(await prisma.auditLog.findMany({ orderBy: { id: "asc" } })).toEqual(auditBefore);
    const rev = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: part.id } });
    for (const [entity, id] of [["part", part.id], ["partProcessRevision", rev.id]] as const) {
      const entries = await readAudit(entity, id);
      expect(entries[0].after).toMatchObject({ recipe: { number: "TAKEN" } });
    }
    await asSystem(() => saveRecipeNumber(part.id, { recipeNumber: null, expectedRecipeNumber: "TAKEN" }));
    for (const [entity, id] of [["part", part.id], ["partProcessRevision", rev.id]] as const) {
      const entries = await readAudit(entity, id);
      expect(entries[0].before).toMatchObject({ recipe: { number: "TAKEN" } });
      expect(entries[0].after).toMatchObject({ recipe: null });
    }
  });
});
