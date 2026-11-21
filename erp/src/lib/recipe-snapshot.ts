import { z } from "zod";

export type RecipeFieldV1 = {
  fieldDefId: string; label: string; type: "NUMBER" | "TEXT" | "DATE" | "CHECKBOX";
  unit: string | null; position: number; value: string | boolean | null;
};
export type RecipeSnapshotV1 = {
  schemaVersion: 1; recipeId: string; recipeNumber: string;
  partId: string; revisionNumber: number;
  steps: { stepId: string; position: number; codeId: string; code: string;
    codeName: string; instruction: string; fields: RecipeFieldV1[] }[];
};

const fieldBase = {
  fieldDefId: z.string().min(1), label: z.string(), unit: z.string().nullable(),
  position: z.number().int().nonnegative(),
};
const field = z.discriminatedUnion("type", [
  z.object({ ...fieldBase, type: z.literal("NUMBER"), value: z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/).nullable() }).strict(),
  z.object({ ...fieldBase, type: z.literal("TEXT"), value: z.string().nullable() }).strict(),
  z.object({ ...fieldBase, type: z.literal("DATE"), value: z.iso.date().nullable() }).strict(),
  z.object({ ...fieldBase, type: z.literal("CHECKBOX"), value: z.boolean().nullable() }).strict(),
]);
const snapshot = z.object({
  schemaVersion: z.literal(1), recipeId: z.string().min(1),
  recipeNumber: z.string().regex(/^[A-Za-z0-9-]{1,20}$/),
  partId: z.string().min(1), revisionNumber: z.number().int().positive(),
  steps: z.array(z.object({
    stepId: z.string().min(1), position: z.number().int().positive(),
    codeId: z.string().min(1), code: z.string(), codeName: z.string(), instruction: z.string(),
    fields: z.array(field),
  }).strict()),
}).strict();

/** Fail closed on unknown versions and malformed persisted data; never infer historical values. */
export function parseRecipeSnapshot(value: unknown): RecipeSnapshotV1 {
  return snapshot.parse(value);
}

/** The one row→snapshot projection, shared by capture and the order-entry preview so an order's
 *  saved fingerprint cannot drift from what capture writes (order-create.ts's 412 check). The key
 *  is the captured `fieldDefId`; an empty value is `null`, and a checkbox string becomes the
 *  boolean the V1 contract types (spec 2026-09-26 §3.4). Anything else stays verbatim so malformed
 *  storage fails the parser instead of silently turning into a value. */
export function recipeFieldFromParameter(p: { key: string; label: string; type: string; unit: string | null; position: number; value: string }): RecipeFieldV1 {
  const value = p.value === "" ? null
    : p.type === "CHECKBOX" && (p.value === "true" || p.value === "false") ? p.value === "true" : p.value;
  return { fieldDefId: p.key, label: p.label, type: p.type as RecipeFieldV1["type"], unit: p.unit, position: p.position, value };
}
