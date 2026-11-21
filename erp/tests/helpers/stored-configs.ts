/**
 * What an install holds in stored templates, for the cases of the weights-on-paper pull request
 * (the weights design §13.5): the seed literal, and customised configs frozen in tests/fixtures/
 * before any contract of that pull request changed.
 *
 * A stored config in a test is read from here. It is never derived from a contract as it stands,
 * and never written into a version row through `editDraft`, which stores the whole parse: every
 * field the contract holds on the day of the save. The three fixture files are only read. The
 * labels file was written once. The configs file was written once more, on 2026-10-12, so that
 * no frozen config repeats the seed's standing text: each text block that held words holds
 * `STAND_IN_TEXT`.
 *
 * The public source holds no seed migration: a public install starts from the
 * heatsynq-public-v2 baseline (docs/public-baseline.md). The seed literals are therefore read from
 * tests/fixtures/seed-literals.json, which holds, for each of the nine types, the literal the seed
 * migrations stored for an install's first Standard, with generic sample text of the same length and
 * shape in the three text blocks (both tickets' liability text and the certification statement) that held a
 * shop's own words (owner ruling 2026-11-20).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "../../prisma/generated/prisma/client";
import type { TemplateDocTypeString } from "@/lib/template-contracts/index";

const FIXTURES = join(process.cwd(), "tests/fixtures");

/** The eight types the first seed migration published, every fixture below frozen over them: the
 *  container tag (the container tag design of 2026-11-13) came after, from its own seed migration,
 *  and no frozen config or label is of it. */
export const FIRST_SEED_TYPES: readonly TemplateDocTypeString[] = [
  "TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE",
];

let seedLiterals: Partial<Record<TemplateDocTypeString, unknown>> | undefined;

/** The seed's stored literal for one document type, read from tests/fixtures/seed-literals.json. A
 *  fresh object each call. Throws on a type the file does not hold. */
export function seedLiteral(docType: TemplateDocTypeString): unknown {
  seedLiterals ??= fixture<Partial<Record<TemplateDocTypeString, unknown>>>("seed-literals.json");
  if (!Object.hasOwn(seedLiterals, docType)) throw new Error(`the seed literals hold no ${docType} literal`);
  return structuredClone(seedLiterals[docType]);
}

function fixture<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as T;
}
const FROZEN = fixture<Partial<Record<TemplateDocTypeString, Record<string, unknown>>>>(
  "stored-configs-before-weights-paper.json");
const LABELS = fixture<Record<TemplateDocTypeString, Record<string, string>>>(
  "built-in-labels-before-weights-paper.json");

/** The names the file holds for one document type, in the file's order. */
export function storedNames(docType: TemplateDocTypeString): string[] {
  return Object.keys(FROZEN[docType] ?? {});
}

/** A frozen customised config by its name. A fresh deep copy each call. Throws on a name the
 *  file does not hold. A text block of it holds `STAND_IN_TEXT`, or is empty where the seed's
 *  is empty: never the seed's wording. */
export function storedBefore(docType: TemplateDocTypeString, name: string): unknown {
  const byName = FROZEN[docType] ?? {};
  if (!Object.hasOwn(byName, name)) {
    throw new Error(`no frozen ${docType} config is named "${name}": the file holds ${storedNames(docType).join(", ") || "none"}`);
  }
  return structuredClone(byName[name]);
}

/** What a frozen config holds in place of the words of a text block. */
export const STAND_IN_TEXT = "Frozen text block.";

/** `config` with its text blocks as a frozen config holds them: `STAND_IN_TEXT` for a block that
 *  holds words, and an empty block left empty, under the same keys. The answer is a new object
 *  with new text blocks, and everything else of it is `config`'s own. For the side of a
 *  comparison that is built from `seedLiteral`. */
export function withStandInText<T>(config: T): T {
  const { textBlocks } = config as { textBlocks: Record<string, string> };
  return {
    ...config,
    textBlocks: Object.fromEntries(
      Object.entries(textBlocks).map(([key, text]) => [key, text === "" ? "" : STAND_IN_TEXT])),
  };
}

/** The field keys this pull request adds. No frozen config holds one. */
export const ADDED_BY_WEIGHTS_PAPER: readonly string[] = ["container_tare", "total_tare", "total_gross"];

/** Every field's built-in label before this pull request, by field key, read from the second
 *  fixture file. */
export function builtInLabelsBefore(docType: TemplateDocTypeString): Readonly<Record<string, string>> {
  return LABELS[docType];
}

/** Writes `config` as it is into a new PUBLISHED version row of that type's re-seeded Standard
 *  template, with Prisma directly, and moves the template's pointer onto it. Never through
 *  `editDraft`. The database client is loaded here, on the first call, and not at the top of this
 *  module: everything above only reads files. */
export async function publishStored(
  docType: TemplateDocTypeString, config: unknown,
): Promise<{ templateId: string; versionId: string }> {
  const { prisma, templateId } = await import("./db");
  const id = templateId(docType);
  const last = await prisma.documentTemplateVersion.aggregate({
    where: { templateId: id }, _max: { versionNumber: true },
  });
  const version = await prisma.documentTemplateVersion.create({
    data: {
      templateId: id, versionNumber: (last._max.versionNumber ?? 0) + 1, status: "PUBLISHED",
      config: config as Prisma.InputJsonValue, publishedAt: new Date(),
    },
    select: { id: true },
  });
  await prisma.documentTemplate.update({ where: { id }, data: { publishedVersionId: version.id } });
  return { templateId: id, versionId: version.id };
}
