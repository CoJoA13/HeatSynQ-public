import { beforeEach, describe, expect, it } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createTemplate, editDraft, openDraft, publishDraft, setDefault } from "@/server/templates";
import { resolveTemplateForPrint } from "@/server/template-assignments";
import { defaultConfigFor, type TemplateConfig } from "@/lib/template-contracts/index";

const STANDING_TEXT = [
  { docType: "CERT", key: "cert_statement" },
  { docType: "SHIPPER", key: "shipper_liability_text" },
  { docType: "MOS_SHIPPER", key: "shipper_liability_text" },
] as const;

let actor: { id: string; name: string };
const as = <T>(fn: () => Promise<T>) => runWithContext({ actor, user: null }, fn);

beforeEach(async () => {
  await truncateAll();
  const user = await prisma.user.create({ data: {
    username: "publication-review", displayName: "Example Template Owner", passwordHash: "x",
  } });
  actor = { id: user.id, name: user.displayName };
});

describe.each(STANDING_TEXT)("$docType publication defaults", ({ docType, key }) => {
  it("starts a newly created draft with blank configurable standing text", async () => {
    const { draft } = await as(() => createTemplate(docType, "New shop template"));
    const row = await prisma.documentTemplateVersion.findUniqueOrThrow({ where: { id: draft.id } });
    const config = row.config as unknown as TemplateConfig;
    expect(Object.hasOwn(config.textBlocks, key)).toBe(true);
    expect(config.textBlocks[key]).toBe("");
  });

  it("starts a reset Standard template with blank configurable standing text", async () => {
    const row = await prisma.documentTemplateVersion.findUniqueOrThrow({
      where: { id: templateVersionId(docType) },
    });
    expect((row.config as unknown as TemplateConfig).textBlocks[key]).toBe("");
  });

  it.each(["Example shop's approved wording.", ""])(
    "preserves explicitly stored text %j through printing, re-drafting and reverting",
    async (existingText) => {
      const { id, draft } = await as(() => createTemplate(docType, "Existing shop template"));
      const config = defaultConfigFor(docType);
      config.textBlocks[key] = existingText;
      await as(() => editDraft(id, { config, updatedAt: draft.updatedAt }));
      const original = await as(() => publishDraft(id));
      await as(() => setDefault(id));
      const storedBefore = await prisma.documentTemplateVersion.findUniqueOrThrow({
        where: { id: original.versionId },
      });
      const customer = await prisma.customer.create({ data: {
        code: "EXAMPLE", name: "Example customer",
      } });
      const resolved = await prisma.$transaction((tx) => resolveTemplateForPrint(tx, docType, customer.id));
      expect(resolved.versionId).toBe(original.versionId);
      expect(resolved.config.textBlocks[key]).toBe(existingText);

      const next = await as(() => openDraft(id));
      expect(next.config.textBlocks[key]).toBe(existingText);
      const changed = { ...next.config, textBlocks: { ...next.config.textBlocks, [key]: "Later approved text." } };
      await as(() => editDraft(id, { config: changed, updatedAt: next.updatedAt }));
      await as(() => publishDraft(id));
      const restored = await as(() => openDraft(id, { fromVersion: 1 }));
      expect(restored.config.textBlocks[key]).toBe(existingText);
      const storedAfter = await prisma.documentTemplateVersion.findUniqueOrThrow({
        where: { id: original.versionId },
      });
      expect(storedAfter).toEqual(storedBefore);
    },
  );
});
