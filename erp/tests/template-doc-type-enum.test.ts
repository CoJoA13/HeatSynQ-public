import { describe, expect, it } from "vitest";
import { TemplateDocType } from "../prisma/generated/prisma/enums";
import { TEMPLATE_DOC_TYPES } from "@/lib/template-contracts/types";

/**
 * The two lists of template types meet only through casts (`templates.ts`, `template-preview.ts`,
 * `template-assignments.ts`), so a value missing on either side compiles and fails at runtime (the
 * container tag design of 2026-11-13, §4, call 1). This holds the Prisma enum and the contracts'
 * list to one set.
 */
describe("TemplateDocType and TEMPLATE_DOC_TYPES", () => {
  it("name the same set of template types", () => {
    expect(new Set(Object.values(TemplateDocType))).toEqual(new Set(TEMPLATE_DOC_TYPES));
    expect(Object.values(TemplateDocType)).toHaveLength(TEMPLATE_DOC_TYPES.length);
  });
});
