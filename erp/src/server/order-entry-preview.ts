import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import type {
  EntryPlanInput,
  EntryPlanPreview,
  EntryProcessContent,
  LoadLimits,
} from "../lib/order-entry-plan";
import { parseRecipeSnapshot, recipeFieldFromParameter } from "../lib/recipe-snapshot";
import { prisma } from "./db";
import { decimalBoxField } from "./decimal-field";
import { LINE_NET_WEIGHT, WEIGHT_PER_LOAD } from "@/lib/order-boxes";
import { HttpError } from "./errors";
import { LINE_QTY, lineTotals, resolveLineParts, runSplitLoads } from "./order-internals";

const ENTRY_LINE = z.object({
  partId: z.string().min(1),
  qty: LINE_QTY,
  weight: decimalBoxField(LINE_NET_WEIGHT.box, { required: true }),
}).strict();

const LOAD_ADJUSTMENT = z.discriminatedUnion("source", [
  z.object({ source: z.literal("part") }).strict(),
  z.object({
    source: z.literal("order"),
    loadQty: z.number().int().min(1).nullable(),
    loadWeight: decimalBoxField(WEIGHT_PER_LOAD.box, { required: true }).nullable(),
  }).strict(),
]);

/** The public preview wire schema. It deliberately shares the create service's exact line
 * quantity and decimal validators, including decimal-string input and destination bounds. */
export const ENTRY_PLAN_INPUT = z.object({
  customerId: z.string().min(1),
  lines: z.array(ENTRY_LINE).min(1),
  loadAdjustment: LOAD_ADJUSTMENT.optional(),
}).strict();

type CanonicalField = {
  fieldDefId: string;
  position: number;
  label: string;
  type: string;
  unit: string | null;
  value: string | boolean | null;
};
type CanonicalStep = {
  stepId: string;
  position: number;
  codeId: string;
  code: string;
  codeName: string;
  instruction: string;
  fields: CanonicalField[];
};
type CanonicalProcess = { recipeNumber: string | null; steps: CanonicalStep[] };

function publicProcess(process: CanonicalProcess): EntryProcessContent {
  return {
    recipeNumber: process.recipeNumber,
    steps: process.steps.map((step) => ({
      position: step.position,
      code: step.code,
      codeName: step.codeName,
      instruction: step.instruction,
      fields: step.fields.map((field) => ({
        label: field.label,
        type: field.type,
        unit: field.unit,
        value: field.value,
      })),
    })),
  };
}

function canonicalCaptured(value: unknown): CanonicalProcess {
  const captured = parseRecipeSnapshot(value);
  return {
    recipeNumber: captured.recipeNumber,
    steps: [...captured.steps]
      .sort((a, b) => a.position - b.position || a.stepId.localeCompare(b.stepId))
      .map((step) => ({
        stepId: step.stepId,
        position: step.position,
        codeId: step.codeId,
        code: step.code,
        codeName: step.codeName,
        instruction: step.instruction,
        fields: [...step.fields]
          .sort((a, b) => a.position - b.position || a.fieldDefId.localeCompare(b.fieldDefId))
          .map((field) => ({
            fieldDefId: field.fieldDefId,
            position: field.position,
            label: field.label,
            type: field.type,
            unit: field.unit,
            value: field.value,
          })),
      })),
  };
}

function cents(value: number): string {
  return String(Math.round(value * 100));
}

/**
 * Resolve the plan entirely through the caller's transaction. This function performs no claims,
 * captures, audit writes, or transaction setup so Task 2 can reuse it inside order creation.
 */
export async function resolveEntryPlan(
  tx: Prisma.TransactionClient,
  input: EntryPlanInput,
  options: { includeProcess: boolean; expectedPreviewFingerprint?: string } = { includeProcess: false },
): Promise<EntryPlanPreview> {
  const customer = await tx.customer.findFirst({
    where: { id: input.customerId, deletedAt: null },
    select: { id: true, active: true },
  });
  if (!customer) throw new HttpError(400, "That customer does not exist");
  if (!customer.active) throw new HttpError(400, "That customer is inactive");

  // The preview line contract is intentionally smaller than order creation's line contract.
  // Supply only the create resolver's required test-only shape so both paths share the exact
  // live/deleted/active/customer ownership rule without preview acquiring quote/serial behavior.
  const parts = await resolveLineParts(tx, customer.id,
    input.lines.map((line) => ({ ...line, serials: [] })));
  const lead = parts[0];

  const revision = await tx.partProcessRevision.findFirst({
    where: { partId: lead.id },
    orderBy: { revisionNumber: "desc" },
    include: {
      recipe: { select: { number: true } },
      steps: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        include: {
          code: { select: { code: true, name: true } },
          parameters: { orderBy: [{ position: "asc" }, { id: "asc" }] },
        },
      },
    },
  });
  if (!revision || revision.steps.length === 0) {
    throw new HttpError(400, "This part has no process steps");
  }

  // The live branch projects the step's own rows through the SAME function capture uses, and
  // builds each field in the captured branch's canonical key order — the fingerprint is a JSON
  // hash, and order creation captures and then compares (order-create.ts), so a key-order drift
  // between the two branches would 412 the first order of every numbered part.
  const process: CanonicalProcess = revision.recipeSnapshot !== null
    ? canonicalCaptured(revision.recipeSnapshot)
    : {
        recipeNumber: revision.recipe?.number ?? null,
        steps: revision.steps.map((step) => ({
          stepId: step.id,
          position: step.position,
          codeId: step.codeId,
          code: step.code.code,
          codeName: step.code.name,
          instruction: step.instruction,
          fields: step.parameters.map((p) => {
            const field = recipeFieldFromParameter(p);
            return {
              fieldDefId: field.fieldDefId,
              position: field.position,
              label: field.label,
              type: field.type,
              unit: field.unit,
              value: field.value,
            };
          }),
        })),
      };

  const defaults: LoadLimits = {
    loadQty: lead.loadQty,
    loadWeight: lead.loadWeight === null ? null : lead.loadWeight.toNumber(),
  };
  const adjustment = input.loadAdjustment ?? { source: "part" as const };
  const source = adjustment.source;
  const effective: LoadLimits = adjustment.source === "order"
    ? { loadQty: adjustment.loadQty, loadWeight: adjustment.loadWeight }
    : defaults;
  const totals = lineTotals(input.lines);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    customerId: customer.id,
    lines: input.lines.map((line) => ({
      partId: line.partId,
      qty: line.qty,
      weightCents: cents(line.weight),
    })),
    leadPartId: lead.id,
    revisionNumber: revision.revisionNumber,
    source,
    defaults: {
      loadQty: defaults.loadQty,
      loadWeightCents: defaults.loadWeight === null ? null : cents(defaults.loadWeight),
    },
    effective: {
      loadQty: effective.loadQty,
      loadWeightCents: effective.loadWeight === null ? null : cents(effective.loadWeight),
    },
    process,
  })).digest("hex");

  // Create supplies this server-owned precondition only after its revision/catalog claims.
  // Compare before splitting: changed defaults may make a previously valid plan unsplittable,
  // but the operator still needs the same review-needed refusal rather than a new split error.
  if (options.expectedPreviewFingerprint !== undefined && fingerprint !== options.expectedPreviewFingerprint) {
    throw new HttpError(412, "The reviewed load plan has changed. Review the process and loads again before saving.");
  }
  const loads = runSplitLoads({
    ...totals,
    loadQty: effective.loadQty,
    loadWeight: effective.loadWeight,
  }).map((load, index) => ({ loadNumber: index + 1, ...load }));

  return {
    fingerprint,
    leadPartId: lead.id,
    revisionNumber: revision.revisionNumber,
    source,
    defaults,
    effective,
    ...(options.includeProcess ? { process: publicProcess(process) } : {}),
    totalQty: totals.totalQty,
    totalWeightCents: totals.totalWeightCents.toString(),
    loads,
  };
}

/** Validate the wire input and resolve one coherent, read-only snapshot. Presentation permission
 * changes only whether process content is returned; it never changes fingerprint semantics. */
export async function previewOrderEntry(
  input: unknown,
  options: { includeProcess: boolean } = { includeProcess: false },
): Promise<EntryPlanPreview> {
  const data = ENTRY_PLAN_INPUT.parse(input) as EntryPlanInput;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return resolveEntryPlan(tx, data, options);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
